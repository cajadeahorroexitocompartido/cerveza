/* =====================================================================
   app.js - Utilidades compartidas de Gestión Licorería
   - Caché local con actualización en segundo plano (stale-while-revalidate)
   - Llamadas a la API sin repetir (si ya hay una igual en curso, se reutiliza)
   - Barra de progreso fina arriba (reemplaza la pantalla de carga bloqueante)
   - Utilidades comunes: money, esc, toast, fechas, skeletons
   ===================================================================== */

const API_URL = "https://script.google.com/macros/s/AKfycbxSSl9VLppU6JH6ZKJ5dlQUn7qz_4DCD5661gIIzpfYFEzQosTIv2XC6g9rddjTU6pMBw/exec";
const CACHE_PREFIX = "lic1_";

const _enVuelo = new Map();   // peticiones GET en curso (clave -> promesa)
const _memoria = new Map();   // copia en memoria de la caché (más rápida que localStorage)
let _version = 0;             // sube cada vez que se modifican datos; evita guardar respuestas viejas
let _activos = 0;             // cantidad de peticiones activas (para la barra de progreso)
let _timerPrecarga = null;

/* ---------------- Estilos propios (barra de progreso + skeleton) ---------------- */
(function inyectarEstilos() {
  const st = document.createElement("style");
  st.textContent = `
    #top-loader { position: fixed; top: 0; left: 0; height: 3px; width: 0; background: #d4a24c;
      z-index: 3000; opacity: 0; pointer-events: none; transition: width .5s ease, opacity .3s ease; }
    #top-loader.activo { opacity: 1; width: 80%; }
    .sk { display: inline-block; height: 12px; width: 70%; border-radius: 6px; vertical-align: middle;
      background: linear-gradient(90deg, #ece7e3 25%, #f7f4f1 40%, #ece7e3 65%);
      background-size: 400% 100%; animation: sk-anim 1.2s ease infinite; }
    .card-metric .sk { height: 22px; width: 60%; background: linear-gradient(90deg, rgba(255,255,255,.25) 25%, rgba(255,255,255,.45) 40%, rgba(255,255,255,.25) 65%); background-size: 400% 100%; }
    @keyframes sk-anim { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
  `;
  document.head.appendChild(st);
})();

function _barra() {
  let b = document.getElementById("top-loader");
  if (!b) {
    b = document.createElement("div");
    b.id = "top-loader";
    document.body.appendChild(b);
  }
  return b;
}

function _cargaInicio() {
  _activos++;
  const b = _barra();
  b.style.width = "";
  b.classList.add("activo");
}

function _cargaFin() {
  _activos = Math.max(0, _activos - 1);
  if (_activos === 0) {
    const b = _barra();
    b.style.width = "100%";
    setTimeout(() => {
      if (_activos === 0) { b.classList.remove("activo"); b.style.width = ""; }
    }, 300);
  }
}

/* ---------------- Utilidades ---------------- */

function money(valor) { return "$" + Number(valor || 0).toFixed(2); }

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Se mantiene por compatibilidad: ya no hay pantalla de carga bloqueante
function ocultarCarga() {
  const overlay = document.getElementById("loading-overlay");
  if (overlay) overlay.remove();
}

function mostrarToast(mensaje, tipo = "success") {
  const contenedor = document.getElementById("toast-container");
  if (!contenedor) return;
  const id = "t" + Date.now() + Math.floor(Math.random() * 1000);
  const html = `
    <div id="${id}" class="toast align-items-center text-white bg-${tipo === "success" ? "success" : "danger"} border-0" role="alert">
      <div class="d-flex">
        <div class="toast-body">${esc(mensaje)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`;
  contenedor.insertAdjacentHTML("beforeend", html);
  const el = document.getElementById(id);
  el.addEventListener("hidden.bs.toast", () => el.remove());
  new bootstrap.Toast(el, { delay: 3500 }).show();
}

function fechaISO(d) {
  const z = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
}
function hoyISO() { return fechaISO(new Date()); }
function haceDiasISO(n) { const d = new Date(); d.setDate(d.getDate() - n); return fechaISO(d); }
function primerDiaMesISO() { const d = new Date(); d.setDate(1); return fechaISO(d); }

// Filas "fantasma" mientras llegan los datos
function filasCarga(columnas, filas = 4) {
  const celda = `<td><span class="sk"></span></td>`;
  return Array.from({ length: filas }, () => `<tr>${celda.repeat(columnas)}</tr>`).join("");
}

/* ---------------- Caché ---------------- */

function _clave(action, params) {
  return CACHE_PREFIX + action + "|" + JSON.stringify(params || {});
}

function leerCache(action, params) {
  const k = _clave(action, params);
  if (_memoria.has(k)) return _memoria.get(k);
  try {
    const raw = localStorage.getItem(k);
    if (raw) {
      const o = JSON.parse(raw);
      _memoria.set(k, o);
      return o;
    }
  } catch (e) { /* sin acceso a localStorage */ }
  return null;
}

function hayCache(action, params) { return !!leerCache(action, params); }

function guardarCache(action, params, data) {
  const k = _clave(action, params);
  const o = { t: Date.now(), data };
  _memoria.set(k, o);
  try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* almacenamiento lleno: se ignora */ }
}

function limpiarCache() {
  _version++;
  _memoria.clear();
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k));
  } catch (e) { /* ignorar */ }
}

/* ---------------- API ---------------- */

// Petición GET directa al servidor (sin mostrar caché). Reutiliza peticiones idénticas en curso.
function apiGet(action, params) {
  const k = _clave(action, params);
  if (_enVuelo.has(k)) return _enVuelo.get(k);

  const versionAlInicio = _version;
  _cargaInicio();

  const ejecutar = async () => {
    let intento = 0;
    while (true) {
      try {
        const qs = new URLSearchParams({ action, ...(params || {}) });
        const res = await fetch(API_URL + "?" + qs.toString());
        const json = await res.json();
        if (!json.ok) {
          const err = new Error(json.error || "Error desconocido");
          err.api = true;
          throw err;
        }
        if (versionAlInicio === _version) guardarCache(action, params, json.data);
        return json.data;
      } catch (e) {
        // Reintenta una vez solo si fue un problema de red; los errores del servidor se muestran tal cual
        if (e.api || intento >= 1) throw e;
        intento++;
      }
    }
  };

  const p = ejecutar().finally(() => { _enVuelo.delete(k); _cargaFin(); });
  _enVuelo.set(k, p);
  return p;
}

// Muestra al instante lo guardado (si existe) y luego actualiza con lo más reciente.
// onData(datos, vieneDeCache) se llama una o dos veces.
function apiGetSWR(action, params, onData, ttlMs) {
  const ttl = ttlMs == null ? 20000 : ttlMs;
  const c = leerCache(action, params);
  if (c) {
    try { onData(c.data, true); } catch (e) { console.error(e); }
    if (Date.now() - c.t < ttl) return Promise.resolve(c.data); // dato muy reciente: no hace falta pedirlo otra vez
  }
  return apiGet(action, params)
    .then(d => { onData(d, false); return d; })
    .catch(e => {
      if (c) {
        mostrarToast("No se pudo actualizar; se muestran los últimos datos guardados", "error");
        return c.data;
      }
      throw e;
    });
}

async function apiPost(action, data) {
  _cargaInicio();
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...(data || {}) }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Error desconocido");
    return json.data;
  } finally {
    // Cualquier cambio puede alterar stock, saldos, reportes... se descarta lo guardado
    limpiarCache();
    _cargaFin();
    programarPrecarga();
  }
}

// Vuelve a pedir en segundo plano lo que más se usa, para que la siguiente pantalla abra al instante
function programarPrecarga() {
  clearTimeout(_timerPrecarga);
  _timerPrecarga = setTimeout(() => {
    ["productos", "presentaciones"].forEach(a => {
      const c = leerCache(a);
      if (!c || Date.now() - c.t > 60000) apiGet(a).catch(() => {});
    });
  }, 1200);
}

/* ---------------- Arranque común ---------------- */

document.addEventListener("DOMContentLoaded", () => {
  const fechaEl = document.getElementById("fecha-actual");
  if (fechaEl) fechaEl.textContent = new Date().toLocaleDateString("es-EC", { year: "numeric", month: "long", day: "numeric" });

  // Si por alguna razón queda la pantalla de carga antigua, se quita
  ocultarCarga();

  // Calienta la caché de productos y precios mientras el usuario navega
  setTimeout(programarPrecarga, 800);

  // App instalable + archivos guardados en el dispositivo
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
