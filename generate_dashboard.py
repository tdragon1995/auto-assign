#!/usr/bin/env python3
"""
Fleet Dashboard Generator

Generates an interactive map dashboard with an activity log panel.
Data is baked in at build time — no API credentials are exposed in the HTML.

The auto-assign workflow rebuilds and deploys this every ~30 minutes.

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


def load_activity_log():
    log_file = os.path.join("docs", "activity_log.json")
    if os.path.exists(log_file):
        try:
            with open(log_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return []


def generate_html(drivers, jobs, activity_log, generated_at):
    status_config = {int(k): v for k, v in DRIVER_STATUS_CONFIG.items()}

    html = HTML_TEMPLATE
    html = html.replace("__BUILD_DRIVERS__", json.dumps(drivers))
    html = html.replace("__BUILD_JOBS__", json.dumps(jobs))
    html = html.replace("__ACTIVITY_LOG__", json.dumps(activity_log, ensure_ascii=False))
    html = html.replace("__STATUS_CONFIG__", json.dumps(status_config))
    html = html.replace("__GENERATED_AT__", generated_at)
    return html


HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fleet Dashboard</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x1F69A;</text></svg>">
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
        .live-badge.snapshot{background:rgba(52,152,219,0.2);color:#3498db}
        .live-badge .dot{
            width:6px;height:6px;border-radius:50%;background:currentColor;
        }

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

        /* ============ Activity Log Panel ============ */
        .log-panel{
            position:absolute;top:15px;right:15px;z-index:1000;width:420px;
            background:rgba(15,15,30,0.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
            border:1px solid rgba(255,255,255,0.08);border-radius:14px;color:#e0e0e0;
            box-shadow:0 8px 32px rgba(0,0,0,0.4);
            max-height:calc(100vh - 30px);display:flex;flex-direction:column;
            transition:transform 0.3s ease, opacity 0.3s ease;
        }
        .log-panel.hidden{
            transform:translateX(440px);opacity:0;pointer-events:none;
        }
        .log-header{
            display:flex;align-items:center;justify-content:space-between;
            padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;
        }
        .log-header h2{font-size:14px;font-weight:700;color:#fff;letter-spacing:-0.2px}
        .log-close{
            background:none;border:none;color:#6b7280;font-size:18px;cursor:pointer;
            padding:2px 6px;border-radius:6px;transition:all 0.2s;
        }
        .log-close:hover{background:rgba(255,255,255,0.1);color:#fff}
        .log-entries{
            flex:1;overflow-y:auto;padding:8px 12px 12px;
            scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.15) transparent;
        }
        .log-entries::-webkit-scrollbar{width:4px}
        .log-entries::-webkit-scrollbar-track{background:transparent}
        .log-entries::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:4px}
        .log-entry{
            padding:4px 8px;margin:1px 0;border-radius:4px;font-size:11px;
            font-family:'Consolas','Menlo','Monaco',monospace;line-height:1.5;
            border-left:3px solid transparent;
        }
        .log-entry:hover{background:rgba(255,255,255,0.04)}
        .log-entry .log-ts{color:#6b7280;margin-right:6px}
        .log-entry .log-lvl{font-weight:700;margin-right:6px;min-width:42px;display:inline-block}
        .log-entry.level-OK{border-left-color:#27ae60}
        .log-entry.level-OK .log-lvl{color:#27ae60}
        .log-entry.level-OK .log-msg{color:#a3d9b1}
        .log-entry.level-ERROR{border-left-color:#e74c3c}
        .log-entry.level-ERROR .log-lvl{color:#e74c3c}
        .log-entry.level-ERROR .log-msg{color:#f0a8a1}
        .log-entry.level-FATAL{border-left-color:#e74c3c}
        .log-entry.level-FATAL .log-lvl{color:#e74c3c}
        .log-entry.level-FATAL .log-msg{color:#f0a8a1}
        .log-entry.level-WARN{border-left-color:#f39c12}
        .log-entry.level-WARN .log-lvl{color:#f39c12}
        .log-entry.level-WARN .log-msg{color:#f5d89a}
        .log-entry.level-INFO{border-left-color:#3498db}
        .log-entry.level-INFO .log-lvl{color:#3498db}
        .log-entry.level-INFO .log-msg{color:#b0d4f1}
        .log-empty{text-align:center;color:#4b5563;padding:40px 20px;font-size:12px}

        .log-toggle-btn{
            position:absolute;top:15px;right:15px;z-index:999;
            background:rgba(15,15,30,0.88);backdrop-filter:blur(12px);
            border:1px solid rgba(255,255,255,0.08);border-radius:10px;
            color:#e0e0e0;padding:10px 16px;cursor:pointer;font-family:inherit;
            font-size:12px;font-weight:600;transition:all 0.2s;
            box-shadow:0 4px 16px rgba(0,0,0,0.3);
        }
        .log-toggle-btn:hover{background:rgba(30,30,60,0.95);color:#fff}
        .log-toggle-btn.hidden{display:none}

        .log-filter{
            display:flex;gap:4px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;
        }
        .log-filter-btn{
            background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
            border-radius:6px;color:#8b8b8b;padding:3px 8px;cursor:pointer;
            font-size:10px;font-family:inherit;transition:all 0.2s;
        }
        .log-filter-btn:hover{background:rgba(255,255,255,0.12);color:#fff}
        .log-filter-btn.active{background:rgba(52,152,219,0.2);border-color:rgba(52,152,219,0.4);color:#7ec8f0}
    </style>
</head>
<body>
<div id="map"></div>

<!-- Left sidebar: stats -->
<div class="sidebar">
    <h1>Fleet Dashboard</h1>
    <div class="meta-row" id="last-update">Updated: __GENERATED_AT__</div>
    <div class="meta-row">
        <span class="live-badge snapshot">
            <span class="dot"></span><span>Snapshot &middot; refreshed every ~30 min</span>
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

    <div id="status-line"></div>
</div>

<!-- Activity Log toggle button (shown when panel is closed) -->
<button class="log-toggle-btn" id="log-toggle" onclick="toggleLogPanel()">Activity Log</button>

<!-- Right panel: activity log -->
<div class="log-panel" id="log-panel">
    <div class="log-header">
        <h2>Activity Log</h2>
        <button class="log-close" onclick="toggleLogPanel()">&times;</button>
    </div>
    <div class="log-filter">
        <button class="log-filter-btn active" data-filter="all" onclick="filterLogs('all',this)">All</button>
        <button class="log-filter-btn" data-filter="OK" onclick="filterLogs('OK',this)">Assigned</button>
        <button class="log-filter-btn" data-filter="ERROR" onclick="filterLogs('ERROR',this)">Errors</button>
        <button class="log-filter-btn" data-filter="WARN" onclick="filterLogs('WARN',this)">Warnings</button>
    </div>
    <div class="log-entries" id="log-entries"></div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
        integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
// ==========================================================
// Build-time data (no API credentials exposed)
// ==========================================================
const STATUS_CONFIG = __STATUS_CONFIG__;
const currentDrivers = __BUILD_DRIVERS__;
const currentJobs = __BUILD_JOBS__;
const activityLog = __ACTIVITY_LOG__;

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
// Render functions
// ==========================================================
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

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

// ==========================================================
// Activity Log
// ==========================================================
let currentFilter = 'all';

function renderActivityLog(filter) {
    const el = document.getElementById('log-entries');
    if (!activityLog || activityLog.length === 0) {
        el.innerHTML = '<div class="log-empty">No activity log entries yet.<br>The auto-assign service writes logs every ~30 minutes.</div>';
        return;
    }

    const filtered = filter === 'all'
        ? activityLog
        : activityLog.filter(e => e.level === filter || (filter === 'ERROR' && e.level === 'FATAL'));

    if (filtered.length === 0) {
        el.innerHTML = '<div class="log-empty">No entries matching this filter.</div>';
        return;
    }

    // Show newest first
    const reversed = [...filtered].reverse();
    el.innerHTML = reversed.map(e => {
        const ts = e.ts ? e.ts.substring(11) : '';  // HH:MM:SS from datetime
        const lvl = e.level || 'INFO';
        const msg = esc(e.msg || '');
        return '<div class="log-entry level-' + lvl + '">' +
            '<span class="log-ts">[' + ts + ']</span>' +
            '<span class="log-lvl">[' + lvl + ']</span>' +
            '<span class="log-msg">' + msg + '</span>' +
            '</div>';
    }).join('');
}

function filterLogs(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderActivityLog(filter);
}

function toggleLogPanel() {
    const panel = document.getElementById('log-panel');
    const toggle = document.getElementById('log-toggle');
    panel.classList.toggle('hidden');
    toggle.classList.toggle('hidden');
}

// ==========================================================
// Initial render
// ==========================================================
renderDrivers(currentDrivers);
renderJobs(currentJobs);
updateStats(currentDrivers, currentJobs);
fitBounds();
renderActivityLog('all');

const statusEl = document.getElementById('status-line');
statusEl.textContent = currentDrivers.length + ' drivers \u2022 ' + currentJobs.length + ' jobs \u2022 ' + activityLog.length + ' log entries';
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

    print("Loading activity log...")
    activity_log = load_activity_log()
    print(f"  {len(activity_log)} log entries")

    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    html = generate_html(drivers, jobs, activity_log, generated_at)

    os.makedirs("docs", exist_ok=True)
    output_path = os.path.join("docs", "index.html")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Dashboard written to {output_path}")
    print(f"  Drivers: {len(drivers)} | Jobs: {len(jobs)} | Logs: {len(activity_log)} | Generated: {generated_at}")


if __name__ == "__main__":
    main()
