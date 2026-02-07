#!/usr/bin/env python3
"""
Headless Auto-Assign Service

Same logic as auto_assign.py but without tkinter — designed to run in CI
(GitHub Actions) or any headless environment.

Polls for unassigned jobs, matches them to drivers via Google Sheets config,
assigns them via the Cartrack API, and sends Zalo notifications.

Environment variables:
  CARTRACK_AUTH    - Prod Authorization header (required)
  CARTRACK_COOKIE  - Prod Cookie header (optional)
  RUN_MINUTES      - How long to run before exiting (default: 25)
"""

import requests
import time
import os
import csv
import sys
import json
from io import StringIO
from datetime import datetime, timedelta
from urllib.parse import quote_plus

# =========================
# API Configuration
# =========================
BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery"

def get_headers():
    auth = os.environ.get("CARTRACK_AUTH", "")
    cookie = os.environ.get("CARTRACK_COOKIE", "")
    if not auth:
        print("[FATAL] CARTRACK_AUTH environment variable not set")
        sys.exit(1)
    headers = {"Authorization": auth, "Content-Type": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    return headers

HEADERS = None  # Initialized in main()

# =========================
# Google Sheets Configuration
# =========================
SHEET_ID = "1Bqsm5atLYUQ4gMsL7zHrbrS6YUu7pEDa-Iy_j_wpCss"
SHEET_GID = "0"
SHEET_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&gid={SHEET_GID}"

# =========================
# Defaults
# =========================
DEFAULT_POLL_INTERVAL = 30
DEFAULT_JOB_MAX_AGE = 60


# =========================
# Activity log (persisted for dashboard)
# =========================
ACTIVITY_LOG = []
ACTIVITY_LOG_FILE = "docs/activity_log.json"


# =========================
# Helpers
# =========================
def log(msg, level="INFO"):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] [{level}] {msg}", flush=True)
    ACTIVITY_LOG.append({
        "ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "level": level,
        "msg": msg,
    })


def parse_time(time_str):
    if not time_str:
        return None
    time_str = time_str.strip()
    try:
        if len(time_str) == 5:
            return datetime.strptime(time_str, "%H:%M").time()
        return datetime.strptime(time_str, "%H:%M:%S").time()
    except ValueError:
        return None


def load_config_from_sheets():
    try:
        response = requests.get(SHEET_URL, timeout=15)
        response.raise_for_status()
        reader = csv.DictReader(StringIO(response.text))
        mappings = []
        for row in reader:
            customer_id = row.get('customer_id', '').strip()
            driver_id = row.get('driver_id', '').strip()
            if customer_id and driver_id:
                mappings.append({
                    'customer_id': customer_id,
                    'driver_id': driver_id,
                    'first_name_last_name': row.get('first_name_last_name', '').strip(),
                    'shift_start': parse_time(row.get('shift_start', '').strip()),
                    'shift_end': parse_time(row.get('shift_end', '').strip()),
                    'bot_token': row.get('bot_token', '').strip(),
                    'chat_id': row.get('chat_id', '').strip(),
                })
        return {
            'mappings': mappings,
            'poll_interval_seconds': DEFAULT_POLL_INTERVAL,
            'job_max_age_minutes': DEFAULT_JOB_MAX_AGE,
        }
    except Exception as e:
        log(f"Error loading config from sheets: {e}", "ERROR")
        return None


def get_unassigned_jobs(page=1, per_page=50):
    params = {"filter[job_status_id]": 2, "page": page, "per_page": per_page}
    response = requests.get(f"{BASE_URL}/jobs", headers=HEADERS, params=params, timeout=30)
    try:
        return response.json()
    except Exception:
        return {"data": []}


def get_customer_id_from_job(job):
    for stop in job.get('stops', []):
        if stop.get('stop_type_id') == 1:
            return stop.get('customer_id')
    return None


def get_customer_name_from_job(job):
    for stop in job.get('stops', []):
        if stop.get('stop_type_id') == 1:
            return stop.get('customer_name') or stop.get('name') or stop.get('address', 'Unknown')
    return None


def is_driver_on_shift(mapping, job_time):
    shift_start = mapping.get('shift_start')
    shift_end = mapping.get('shift_end')
    if shift_start is None or shift_end is None:
        return True
    job_time_only = job_time.time()
    if shift_start > shift_end:
        return job_time_only >= shift_start or job_time_only <= shift_end
    return shift_start <= job_time_only <= shift_end


def get_drivers_on_duty(config, customer_id, job_time):
    customer_mappings = [m for m in config.get('mappings', []) if m['customer_id'] == customer_id]
    if not customer_mappings:
        return [], 'no_mapping'
    drivers_on_duty = [m for m in customer_mappings if is_driver_on_shift(m, job_time)]
    if len(drivers_on_duty) == 0:
        return customer_mappings, 'no_driver'
    if len(drivers_on_duty) == 1:
        return drivers_on_duty, 'happy'
    return drivers_on_duty, 'clash'


def assign_job(driver_id, job_id, first_name_last_name=None):
    payload = {"job_ids": [job_id]}
    if first_name_last_name:
        encoded_name = quote_plus(first_name_last_name)
        assign_url = f"{BASE_URL}/jobs/assign/{encoded_name}"
        response = requests.put(assign_url, headers=HEADERS, json=payload, timeout=30)
        if response.status_code == 200:
            return response.status_code, response.json(), first_name_last_name
    assign_url = f"{BASE_URL}/jobs/assign/{driver_id}"
    response = requests.put(assign_url, headers=HEADERS, json=payload, timeout=30)
    return response.status_code, response.json(), driver_id


def get_job_details(job_id):
    response = requests.get(f"{BASE_URL}/jobs/{job_id}", headers=HEADERS, timeout=30)
    try:
        return response.json()
    except Exception:
        return {"data": {}}


def is_job_recent(job, max_age_minutes):
    create_ts = job.get('create_ts')
    if not create_ts:
        return False
    try:
        job_time = datetime.strptime(create_ts, "%Y-%m-%d %H:%M:%S")
        return job_time >= datetime.now() - timedelta(minutes=max_age_minutes)
    except ValueError:
        return False


def job_has_notes(job):
    for stop in job.get('stops', []):
        note = stop.get('note')
        if note and str(note).strip() and str(note).strip() != "Call before delivery":
            return True
    return False


def build_gmaps_route_link(stop1_lat, stop1_lng, stop2_lat, stop2_lng):
    if None in (stop1_lat, stop1_lng, stop2_lat, stop2_lng):
        return None
    saddr = quote_plus("Current Location")
    return (
        "https://maps.google.com/maps?"
        "directionsmode=motorbike"
        f"&saddr={saddr}"
        f"&daddr={stop1_lat},{stop1_lng}+to:{stop2_lat},{stop2_lng}"
    )


def send_zalo_message(bot_token, chat_id, text):
    if not bot_token or not chat_id:
        return None
    url = f"https://bot-api.zaloplatforms.com/bot{bot_token}/sendMessage"
    try:
        r = requests.post(url, json={"chat_id": chat_id, "text": text}, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


# =========================
# Main auto-assign cycle
# =========================
def auto_assign_cycle(config):
    try:
        jobs_data = get_unassigned_jobs()
        jobs = jobs_data.get("data", [])
    except Exception as e:
        log(f"Error fetching jobs: {e}", "ERROR")
        return

    if not jobs:
        log("No unassigned jobs")
        return

    max_age = config.get('job_max_age_minutes', DEFAULT_JOB_MAX_AGE)
    jobs = [j for j in jobs if is_job_recent(j, max_age)]

    if not jobs:
        log(f"No jobs within last {max_age} min")
        return

    log(f"Found {len(jobs)} recent job(s)")

    for job in jobs:
        job_id = job.get('job_id')
        customer_id = get_customer_id_from_job(job)
        job_customer_name = get_customer_name_from_job(job)

        if job_has_notes(job):
            log(f"Job {job_id} - SKIPPED: stop has note")
            continue

        if not customer_id:
            log(f"Job {job_id} - No pickup stop found", "ERROR")
            continue

        create_ts = job.get('create_ts')
        try:
            job_time = datetime.strptime(create_ts, "%Y-%m-%d %H:%M:%S")
        except (ValueError, TypeError):
            job_time = datetime.now()

        drivers, status = get_drivers_on_duty(config, customer_id, job_time)

        if status == 'no_mapping':
            log(f"Job {job_id} - NO MAPPING: customer {customer_id} not configured", "ERROR")
            continue

        if status == 'no_driver':
            shift_info = [f"{m.get('driver_id')} ({m.get('shift_start')}-{m.get('shift_end')})" for m in drivers]
            log(f"Job {job_id} - NO DRIVER ON DUTY at {job_time.strftime('%H:%M')} | Configured: {', '.join(shift_info)}", "ERROR")
            continue

        if status == 'clash':
            driver_list = [f"{m.get('driver_id')} ({m.get('shift_start')}-{m.get('shift_end')})" for m in drivers]
            log(f"Job {job_id} - CLASH: {len(drivers)} drivers on duty at {job_time.strftime('%H:%M')}: {', '.join(driver_list)}", "WARN")
            continue

        # Exactly one driver on duty
        mapping = drivers[0]
        driver_id = mapping.get('driver_id')
        first_name_last_name = mapping.get('first_name_last_name')
        if not driver_id:
            continue

        try:
            api_status, response, identifier_used = assign_job(driver_id, job_id, first_name_last_name)

            if api_status == 200:
                job_details = get_job_details(job_id)
                data = job_details.get('data', {})
                stops = data.get('stops', [])

                pickup_name = stops[0].get('customer_name', 'N/A') if len(stops) >= 1 else 'N/A'
                dropoff_name = stops[1].get('customer_name', 'N/A') if len(stops) >= 2 else 'N/A'

                driver_data = data.get('driver', {})
                resp_driver_name = f"{driver_data.get('first_name', '')} {driver_data.get('last_name', '')}".strip() or 'N/A'

                job_url = f"https://fleetweb-vn.cartrack.com/delivery/map?job={job_id}"
                log(f"✓ Job {job_id} ({job_url}) | {resp_driver_name} → {pickup_name}", "OK")

                # Google Maps route link
                route_link = None
                if len(stops) >= 2:
                    route_link = build_gmaps_route_link(
                        stops[0].get('latitude'), stops[0].get('longitude'),
                        stops[1].get('latitude'), stops[1].get('longitude'),
                    )

                # Zalo notification
                bot_token = mapping.get('bot_token')
                chat_id = mapping.get('chat_id')
                if bot_token and chat_id:
                    zalo_lines = [
                        f"New job assigned: {job_id}",
                        f"Pickup (Stop 1): {pickup_name if pickup_name != 'N/A' else (job_customer_name or 'N/A')}",
                        f"Dropoff (Stop 2): {dropoff_name}",
                    ]
                    if route_link:
                        zalo_lines.append(f"Route (motorbike): {route_link}")
                    else:
                        zalo_lines.append("Route: (missing coordinates)")

                    result = send_zalo_message(bot_token, chat_id, "\n".join(zalo_lines))
                    if result:
                        log("Zalo notification sent")
            else:
                error_msg = response.get('message', str(response))
                log(f"✗ Job {job_id} failed: {error_msg}", "ERROR")

        except Exception as e:
            log(f"✗ Job {job_id} error: {e}", "ERROR")


# =========================
# Activity log persistence
# =========================
def save_activity_log():
    """Merge current run's log with existing history and save to JSON."""
    existing = []
    if os.path.exists(ACTIVITY_LOG_FILE):
        try:
            with open(ACTIVITY_LOG_FILE, 'r', encoding='utf-8') as f:
                existing = json.load(f)
        except Exception:
            existing = []

    combined = existing + ACTIVITY_LOG
    combined = combined[-500:]  # Keep last 500 entries

    os.makedirs(os.path.dirname(ACTIVITY_LOG_FILE) or '.', exist_ok=True)
    with open(ACTIVITY_LOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(combined, f, ensure_ascii=False)


# =========================
# Entry point
# =========================
def main():
    global HEADERS
    HEADERS = get_headers()

    run_minutes = int(os.environ.get("RUN_MINUTES", "25"))
    log(f"Auto-Assign Headless Service starting (will run for {run_minutes} min)")

    config = load_config_from_sheets()
    if not config:
        log("Failed to load config from Google Sheets, exiting", "FATAL")
        save_activity_log()
        sys.exit(1)

    log(f"Config loaded: {len(config.get('mappings', []))} mapping(s)")

    poll_interval = config.get('poll_interval_seconds', DEFAULT_POLL_INTERVAL)
    end_time = datetime.now() + timedelta(minutes=run_minutes)

    while datetime.now() < end_time:
        log("Checking for unassigned jobs...")
        auto_assign_cycle(config)

        # Wait, checking for exit every second
        for _ in range(poll_interval):
            if datetime.now() >= end_time:
                break
            time.sleep(1)

    log(f"Run time ({run_minutes} min) reached, exiting cleanly")
    save_activity_log()


if __name__ == "__main__":
    main()
