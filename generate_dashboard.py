#!/usr/bin/env python3
"""
Fleet Dashboard Generator

Generates an interactive map dashboard that fetches live data every 15 seconds
directly from the Cartrack API via JavaScript.

Build-time data is embedded as a fallback in case browser-side fetch fails (CORS).

Required environment variables:
  CARTRACK_AUTH         - Prod Authorization header (for jobs + drivers)
  CARTRACK_COOKIE       - Prod Cookie header (optional)
  CARTRACK_DRIVERS_AUTH - Drivers-specific auth (optional, falls back to CARTRACK_AUTH)
  CARTRACK_DRIVERS_COOKIE - Drivers-specific cookie (optional)
"""

import requests
import json
import os
from datetime import datetime, timedelta


BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery"

DRIVER_STATUS_CONFIG = {
    1: {"name": "Online", "color": "#27ae60"},
    2: {"name": "On Route", "color": "#3498db"},
    3: {"name": "Not Active", "color": "#95a5a6"},
    4: {"name": "Offline", "color": "#e74c3c"},
    5: {"name": "On Break", "color": "#f39c12"},
}


def make_headers(auth_value, cookie_value=""):
    if not auth_value:
        return None
    headers = {"Authorization": auth_value, "Content-Type": "application/json"}
    if cookie_value:
        headers["Cookie"] = cookie_value
    return headers


def fetch_drivers():
    auth = os.environ.get("CARTRACK_DRIVERS_AUTH") or os.environ.get("CARTRACK_AUTH", "")
    cookie = os.environ.get("CARTRACK_DRIVERS_COOKIE") or os.environ.get("CARTRACK_COOKIE", "")
    headers = make_headers(auth, cookie)
    if not headers:
        print("  No auth for drivers, skipping")
        return []
    try:
        resp = requests.get(f"{BASE_URL}/drivers", headers=headers,
                            params={"page": 1, "limit": 1000}, timeout=30)
        data = resp.json()
        drivers = []
        for d in data.get("data", []):
            lat, lon = d.get("latitude"), d.get("longitude")
            if lat is None or lon is None:
                continue
            try:
                lat, lon = float(lat), float(lon)
            except (ValueError, TypeError):
                continue
            drivers.append({
                "name": f"{d.get('first_name', '')} {d.get('last_name', '')}".strip() or "Unknown",
                "lat": lat, "lon": lon,
                "status_id": d.get("driver_status_id", 0),
                "phone": d.get("phone_number", ""),
                "is_online": bool(d.get("is_online")),
                "is_active": bool(d.get("is_active")),
            })
        return drivers
    except Exception as e:
        print(f"  Error fetching drivers: {e}")
        return []


def fetch_unassigned_jobs():
    auth = os.environ.get("CARTRACK_AUTH", "")
    cookie = os.environ.get("CARTRACK_COOKIE", "")
    headers = make_headers(auth, cookie)
    if not headers:
        print("  No auth for jobs, skipping")
        return []
    try:
        resp = requests.get(f"{BASE_URL}/jobs", headers=headers,
                            params={"filter[job_status_id]": 2, "page": 1, "per_page": 100},
                            timeout=30)
        data = resp.json()
        cutoff = datetime.now() - timedelta(hours=2)
        jobs = []
        for j in data.get("data", []):
            create_ts = j.get("create_ts", "")
            try:
                if datetime.strptime(create_ts, "%Y-%m-%d %H:%M:%S") < cutoff:
                    continue
            except ValueError:
                pass
            stops = []
            for s in j.get("stops", []):
                lat, lon = s.get("latitude"), s.get("longitude")
                if lat is None or lon is None:
                    continue
                try:
                    lat, lon = float(lat), float(lon)
                except (ValueError, TypeError):
                    continue
                stops.append({
                    "lat": lat, "lon": lon,
                    "name": s.get("customer_name") or s.get("name") or s.get("address", "Unknown"),
                    "type": s.get("stop_type_id", 0),
                    "address": s.get("address", ""),
                })
            if stops:
                jobs.append({"id": j.get("job_id"), "stops": stops, "created": create_ts})
        return jobs
    except Exception as e:
        print(f"  Error fetching jobs: {e}")
        return []


def generate_html(drivers, jobs, generated_at):
    prod_auth = os.environ.get("CARTRACK_AUTH", "")
    prod_cookie = os.environ.get("CARTRACK_COOKIE", "")
    drivers_auth = os.environ.get("CARTRACK_DRIVERS_AUTH") or prod_auth
    drivers_cookie = os.environ.get("CARTRACK_DRIVERS_COOKIE") or prod_cookie
    status_config = {int(k): v for k, v in DRIVER_STATUS_CONFIG.items()}

    html = HTML_TEMPLATE
    html = html.replace("__BUILD_DRIVERS__", json.dumps(drivers))
    html = html.replace("__BUILD_JOBS__", json.dumps(jobs))
    html = html.replace("__STATUS_CONFIG__", json.dumps(status_config))
    html = html.replace("__GENERATED_AT__", generated_at)
    html = html.replace("__PROD_AUTH__", prod_auth)
    html = html.replace("__PROD_COOKIE__", prod_cookie)
    html = html.replace("__DRIVERS_AUTH__", drivers_auth)
    html = html.replace("__DRIVERS_COOKIE__", drivers_cookie)
    return html


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fleet Dashboard</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚚</text></svg>">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin=""/>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif;overflow:hidden}
        #map{position:absolute;top:0;left:0;right:0;bottom:0;z-index:1}

        .sidebar{
            position:absolute;top:15px;left:15px;z-index:1000;width:260px;
            background:rgba(15,15,30,0.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
            border:1px solid rgba(255,255,255,0.08);border-radius:14px;color:#e0e0e0;padding:20px;
            box-shadow:0 8px 32px rgba(0,0,0,0.4);max-height:calc(100vh - 30px);overflow-y:auto;
            scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.15) transparent;
        }
        .sidebar::-webkit-scrollbar{width:4px}
        .sidebar::-webkit-scrollbar-track{background:transparent}
        .sidebar::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:4px}
        .sidebar h1{font-size:17px;font-weight:700;color:#fff;margin-bottom:2px;letter-spacing:-0.3px}
        .meta-row{font-size:11px;color:#6b7280;margin-bottom:4px}

        .live-badge{
            display:inline-flex;align-items:center;gap:5px;
            padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;
        }
        .live-badge.live{background:rgba(39,174,96,0.2);color:#27ae60}
        .live-badge.stale{background:rgba(231,76,60,0.2);color:#e74c3c}
        .live-badge .dot{
            width:6px;height:6px;border-radius:50%;background:currentColor;
        }
        .live-badge.live .dot{animation:blink 1.5s infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}

        .section-title{
            font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:#6b7280;
            margin:18px 0 8px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.06);
        }
        .stat-row{display:flex;align-items:center;padding:5px 0}
        .stat-dot{width:10px;height:10px;border-radius:50%;margin-right:10px;flex-shrink:0;box-shadow:0 0 6px currentColor}
        .stat-label{flex:1;font-size:12.5px;color:#c0c0c0}
        .stat-count{font-size:13px;font-weight:700;color:#fff;min-width:24px;text-align:right}
        .stat-total .stat-label{font-weight:700;color:#fff}

        .toggle-btn{
            display:block;width:100%;padding:7px 10px;margin:3px 0;
            border:1px solid rgba(255,255,255,0.1);border-radius:8px;
            background:rgba(255,255,255,0.04);color:#a0a0a0;cursor:pointer;
            font-size:11.5px;text-align:left;transition:all 0.2s;font-family:inherit;
        }
        .toggle-btn:hover{background:rgba(255,255,255,0.1);color:#fff}
        .toggle-btn.active{background:rgba(52,152,219,0.15);border-color:rgba(52,152,219,0.4);color:#7ec8f0}
        .toggle-btn .ind{
            display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;
            background:rgba(255,255,255,0.15);transition:background 0.2s;
        }
        .toggle-btn.active .ind{background:#3498db;box-shadow:0 0 6px #3498db}

        #status-line{font-size:10px;color:#4b5563;margin-top:14px;text-align:center}

        @keyframes pulse-demand{
            0%{box-shadow:0 0 0 0 rgba(233,30,99,0.5)}
            70%{box-shadow:0 0 0 8px rgba(233,30,99,0)}
            100%{box-shadow:0 0 0 0 rgba(233,30,99,0)}
        }
        .demand-pin{animation:pulse-demand 2s infinite}
        .leaflet-popup-content-wrapper{border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.2)}
        .leaflet-popup-content{margin:12px 14px}
    </style>
</head>
<body>
<div id="map"></div>
<div class="sidebar">
    <h1>Fleet Dashboard</h1>
    <div class="meta-row" id="last-update">Built: __GENERATED_AT__</div>
    <div class="meta-row">
        <span class="live-badge stale" id="live-badge">
            <span class="dot"></span><span id="badge-text">Connecting...</span>
        </span>
    </div>

    <div class="section-title">Supply &mdash; Drivers</div>
    <div id="driver-stats"></div>

    <div class="section-title">Demand &mdash; Unassigned Jobs</div>
    <div id="job-stats"></div>

    <div class="section-title">Layers</div>
    <button class="toggle-btn active" id="btn-drivers" onclick="toggleLayer('drivers')"><span class="ind"></span>Drivers</button>
    <button class="toggle-btn active" id="btn-pickups" onclick="toggleLayer('pickups')"><span class="ind"></span>Pickups</button>
    <button class="toggle-btn active" id="btn-dropoffs" onclick="toggleLayer('dropoffs')"><span class="ind"></span>Dropoffs</button>
    <button class="toggle-btn active" id="btn-routes" onclick="toggleLayer('routes')"><span class="ind"></span>Routes</button>

    <div id="status-line">Starting...</div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
// ==========================================================
// API credentials (injected at build time from GitHub secrets)
// ==========================================================
const API = {
    base: 'https://fleetapi-vn.cartrack.com/rest/delivery',
    prodAuth: '__PROD_AUTH__',
    prodCookie: '__PROD_COOKIE__',
    driversAuth: '__DRIVERS_AUTH__',
    driversCookie: '__DRIVERS_COOKIE__',
};

const STATUS_CONFIG = __STATUS_CONFIG__;

// Build-time fallback data
let currentDrivers = __BUILD_DRIVERS__;
let currentJobs = __BUILD_JOBS__;
let isLive = false;
let hasFittedBounds = false;
let refreshCount = 0;

// ==========================================================
// Map
// ==========================================================
const map = L.map('map', { zoomControl: false });
L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '\u00a9 <a href="https://www.openstreetmap.org/copyright">OSM</a> \u00a9 <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19, subdomains: 'abcd',
}).addTo(map);

const layers = {
    drivers:  L.layerGroup().addTo(map),
    pickups:  L.layerGroup().addTo(map),
    dropoffs: L.layerGroup().addTo(map),
    routes:   L.layerGroup().addTo(map),
};
const layerVisible = { drivers: true, pickups: true, dropoffs: true, routes: true };

function toggleLayer(name) {
    layerVisible[name] = !layerVisible[name];
    const btn = document.getElementById('btn-' + name);
    if (layerVisible[name]) { map.addLayer(layers[name]); btn.classList.add('active'); }
    else { map.removeLayer(layers[name]); btn.classList.remove('active'); }
}

// ==========================================================
// Parsing helpers (for live API responses)
// ==========================================================
function parseDrivers(apiData) {
    return (apiData.data || [])
        .filter(d => d.latitude != null && d.longitude != null)
        .map(d => ({
            name: ((d.first_name||'') + ' ' + (d.last_name||'')).trim() || 'Unknown',
            lat: parseFloat(d.latitude), lon: parseFloat(d.longitude),
            status_id: d.driver_status_id || 0,
            phone: d.phone_number || '',
            is_online: !!d.is_online,
            is_active: !!d.is_active,
        }));
}

function parseJobs(apiData) {
    const cutoff = Date.now() - 2*60*60*1000;
    return (apiData.data || [])
        .filter(j => {
            try { return new Date(j.create_ts.replace(' ','T')).getTime() >= cutoff; }
            catch(e) { return true; }
        })
        .map(j => ({
            id: j.job_id,
            created: j.create_ts || '',
            stops: (j.stops || [])
                .filter(s => s.latitude != null && s.longitude != null)
                .map(s => ({
                    lat: parseFloat(s.latitude), lon: parseFloat(s.longitude),
                    name: s.customer_name || s.name || s.address || 'Unknown',
                    type: s.stop_type_id || 0,
                    address: s.address || '',
                })),
        }))
        .filter(j => j.stops.length > 0);
}

// ==========================================================
// Render functions
// ==========================================================
function renderDrivers(drivers) {
    layers.drivers.clearLayers();
    drivers.forEach(d => {
        const cfg = STATUS_CONFIG[d.status_id] || {name:'Unknown',color:'#7f8c8d'};
        L.circleMarker([d.lat, d.lon], {
            radius:7, color:'#fff', weight:2, fillColor:cfg.color, fillOpacity:0.9,
        })
        .bindPopup(
            '<div style="font-family:Segoe UI,sans-serif;min-width:160px;">' +
            '<h4 style="margin:0 0 6px;color:#1e3a5f;font-size:14px;">' + esc(d.name) + '</h4>' +
            '<p style="margin:3px 0;font-size:12px;"><b>Status:</b> <span style="color:'+cfg.color+';font-weight:700;">'+cfg.name+'</span></p>' +
            '<p style="margin:3px 0;font-size:12px;"><b>Phone:</b> '+(d.phone||'N/A')+'</p>' +
            '<p style="margin:3px 0;font-size:12px;"><b>Online:</b> '+(d.is_online?'Yes':'No')+
            ' &middot; <b>Active:</b> '+(d.is_active?'Yes':'No')+'</p></div>'
        )
        .bindTooltip(d.name, {direction:'top', offset:[0,-8]})
        .addTo(layers.drivers);
    });
}

function renderJobs(jobs) {
    layers.pickups.clearLayers();
    layers.dropoffs.clearLayers();
    layers.routes.clearLayers();

    jobs.forEach(job => {
        const pickup = job.stops.find(s => s.type === 1);
        const dropoffs = job.stops.filter(s => s.type !== 1);

        if (pickup) {
            L.marker([pickup.lat, pickup.lon], {
                icon: L.divIcon({
                    className: '',
                    html: '<div class="demand-pin" style="width:14px;height:14px;background:#e91e63;border:2px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(233,30,99,0.5);"></div>',
                    iconSize:[14,14], iconAnchor:[7,14], popupAnchor:[0,-14],
                }),
            })
            .bindPopup(
                '<div style="font-family:Segoe UI,sans-serif;">' +
                '<h4 style="margin:0 0 4px;color:#e91e63;font-size:13px;">Pickup</h4>' +
                '<p style="margin:2px 0;font-size:12px;"><b>Job:</b> '+job.id+'</p>' +
                '<p style="margin:2px 0;font-size:12px;"><b>Customer:</b> '+esc(pickup.name)+'</p>' +
                '<p style="margin:2px 0;font-size:12px;"><b>Address:</b> '+esc(pickup.address)+'</p>' +
                '<p style="margin:2px 0;font-size:11px;color:#999;"><b>Created:</b> '+job.created+'</p>' +
                '<p style="margin:4px 0 0;"><a href="https://fleetweb-vn.cartrack.com/delivery/map?job='+job.id+
                '" target="_blank" style="color:#e91e63;font-size:11px;">Open in Cartrack</a></p></div>'
            )
            .addTo(layers.pickups);
        }

        dropoffs.forEach(drop => {
            L.marker([drop.lat, drop.lon], {
                icon: L.divIcon({
                    className: '',
                    html: '<div style="width:10px;height:10px;background:#9c27b0;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(156,39,176,0.4);"></div>',
                    iconSize:[10,10], iconAnchor:[5,5], popupAnchor:[0,-5],
                }),
            })
            .bindPopup(
                '<div style="font-family:Segoe UI,sans-serif;">' +
                '<h4 style="margin:0 0 4px;color:#9c27b0;font-size:13px;">Dropoff</h4>' +
                '<p style="margin:2px 0;font-size:12px;"><b>Job:</b> '+job.id+'</p>' +
                '<p style="margin:2px 0;font-size:12px;"><b>Customer:</b> '+esc(drop.name)+'</p>' +
                '<p style="margin:2px 0;font-size:12px;"><b>Address:</b> '+esc(drop.address)+'</p></div>'
            )
            .addTo(layers.dropoffs);
        });

        if (pickup) {
            dropoffs.forEach(drop => {
                L.polyline([[pickup.lat,pickup.lon],[drop.lat,drop.lon]],
                    {color:'#e91e63',weight:1.5,dashArray:'6,8',opacity:0.45}
                ).addTo(layers.routes);
            });
        }
    });
}

function updateStats(drivers, jobs) {
    const counts = {};
    drivers.forEach(d => { counts[d.status_id] = (counts[d.status_id]||0)+1; });

    let h = '<div class="stat-row stat-total"><span class="stat-label">Total</span><span class="stat-count">'+drivers.length+'</span></div>';
    Object.keys(STATUS_CONFIG).sort().forEach(id => {
        const c = STATUS_CONFIG[id];
        h += '<div class="stat-row"><div class="stat-dot" style="background:'+c.color+';color:'+c.color+';"></div>' +
             '<span class="stat-label">'+c.name+'</span><span class="stat-count">'+(counts[id]||0)+'</span></div>';
    });
    document.getElementById('driver-stats').innerHTML = h;

    const pc = jobs.reduce((n,j)=>n+j.stops.filter(s=>s.type===1).length,0);
    const dc = jobs.reduce((n,j)=>n+j.stops.filter(s=>s.type!==1).length,0);
    document.getElementById('job-stats').innerHTML =
        '<div class="stat-row stat-total"><span class="stat-label">Unassigned Jobs</span><span class="stat-count">'+jobs.length+'</span></div>' +
        '<div class="stat-row"><div class="stat-dot" style="background:#e91e63;color:#e91e63;border-radius:3px;transform:rotate(45deg);"></div>' +
        '<span class="stat-label">Pickup stops</span><span class="stat-count">'+pc+'</span></div>' +
        '<div class="stat-row"><div class="stat-dot" style="background:#9c27b0;color:#9c27b0;"></div>' +
        '<span class="stat-label">Dropoff stops</span><span class="stat-count">'+dc+'</span></div>';
}

function fitBounds() {
    const pts = [];
    currentDrivers.forEach(d => pts.push([d.lat, d.lon]));
    currentJobs.forEach(j => j.stops.forEach(s => pts.push([s.lat, s.lon])));
    if (pts.length > 0) map.fitBounds(pts, {padding:[60,60], maxZoom:14});
    else map.setView([10.8, 106.7], 12);
}

function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

function now() { return new Date().toLocaleTimeString('en-GB',{hour12:false}); }

function setBadge(live, text) {
    const b = document.getElementById('live-badge');
    const t = document.getElementById('badge-text');
    b.className = 'live-badge ' + (live ? 'live' : 'stale');
    t.textContent = text;
}

// ==========================================================
// Live fetch (every 15 seconds)
// ==========================================================
async function fetchLive() {
    refreshCount++;
    const statusEl = document.getElementById('status-line');
    statusEl.textContent = 'Refreshing... (#' + refreshCount + ')';

    let gotDrivers = false, gotJobs = false;

    // --- Fetch drivers ---
    if (API.driversAuth) {
        try {
            const resp = await fetch(API.base + '/drivers?page=1&limit=1000', {
                headers: { 'Authorization': API.driversAuth, 'Content-Type': 'application/json' },
            });
            if (resp.ok) {
                currentDrivers = parseDrivers(await resp.json());
                gotDrivers = true;
            }
        } catch(e) { console.warn('Driver fetch failed:', e); }
    }

    // --- Fetch jobs ---
    if (API.prodAuth) {
        try {
            const resp = await fetch(API.base + '/jobs?filter%5Bjob_status_id%5D=2&page=1&per_page=100', {
                headers: { 'Authorization': API.prodAuth, 'Content-Type': 'application/json' },
            });
            if (resp.ok) {
                currentJobs = parseJobs(await resp.json());
                gotJobs = true;
            }
        } catch(e) { console.warn('Jobs fetch failed:', e); }
    }

    // --- Re-render ---
    renderDrivers(currentDrivers);
    renderJobs(currentJobs);
    updateStats(currentDrivers, currentJobs);
    if (!hasFittedBounds && (currentDrivers.length || currentJobs.length)) {
        fitBounds();
        hasFittedBounds = true;
    }

    // --- Update status ---
    const t = now();
    document.getElementById('last-update').textContent = 'Updated: ' + t;
    if (gotDrivers || gotJobs) {
        isLive = true;
        setBadge(true, 'Live \u00b7 ' + t);
        statusEl.textContent = 'Live \u2022 ' + currentDrivers.length + ' drivers \u2022 ' + currentJobs.length + ' jobs \u2022 #' + refreshCount;
    } else if (!isLive) {
        setBadge(false, 'Build-time data');
        statusEl.textContent = 'Using build-time data (API fetch failed \u2014 CORS?)';
    }
}

// ==========================================================
// Initial render + start polling
// ==========================================================
renderDrivers(currentDrivers);
renderJobs(currentJobs);
updateStats(currentDrivers, currentJobs);
fitBounds();

// First live fetch immediately, then every 15s
fetchLive();
setInterval(fetchLive, 15000);

// Countdown display
let countdown = 15;
setInterval(() => {
    countdown--;
    if (countdown <= 0) countdown = 15;
    const el = document.getElementById('status-line');
    if (isLive && countdown > 1) {
        el.textContent = el.textContent.split(' \u2022 next')[0] + ' \u2022 next in ' + countdown + 's';
    }
}, 1000);
</script>
</body>
</html>"""


def main():
    print("Fleet Dashboard Generator")
    print("=" * 40)

    print("Fetching build-time drivers...")
    drivers = fetch_drivers()
    print(f"  {len(drivers)} drivers with location")

    print("Fetching build-time jobs...")
    jobs = fetch_unassigned_jobs()
    print(f"  {len(jobs)} recent unassigned jobs")

    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    html = generate_html(drivers, jobs, generated_at)

    os.makedirs("docs", exist_ok=True)
    output_path = os.path.join("docs", "index.html")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Dashboard written to {output_path}")
    print(f"  Drivers: {len(drivers)} | Jobs: {len(jobs)} | Generated: {generated_at}")


if __name__ == "__main__":
    main()
