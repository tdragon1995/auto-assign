import requests
import time
import threading
import tkinter as tk
from tkinter import scrolledtext
from datetime import datetime, timedelta
import csv
from io import StringIO
import webbrowser
import re
import platform
from urllib.parse import quote_plus

# =========================
# API Configuration
# =========================
BASE_URL = "https://fleetapi-vn.cartrack.com/rest/delivery"
HEADERS = {
    "Authorization": "Basic Q05HVDAwMDAyOjZkMjFiY2EwYWQ0NjZjNWZmNDk3Y2I5YWFiMjI0MDc2ZGFiZGM1ZDgzMWYyOTJhOGZkM2U0ZjJjMjU4ZGI1ZDU=",
    "Cookie": "CTSID=gLi0DcEP5JnWRLoVEks34ASD-Gi2I1yvwJW6biyCD4a25t0U",
    "Content-Type": "application/json"
}

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
# Helpers
# =========================
def parse_time(time_str):
    """Parse time string (HH:MM or HH:MM:SS) to time object."""
    if not time_str:
        return None
    time_str = time_str.strip()
    try:
        if len(time_str) == 5:  # HH:MM
            return datetime.strptime(time_str, "%H:%M").time()
        return datetime.strptime(time_str, "%H:%M:%S").time()
    except ValueError:
        return None


def load_config_from_sheets():
    """Fetch mappings from Google Sheets and return config dict."""
    try:
        response = requests.get(SHEET_URL, timeout=15)
        response.raise_for_status()

        reader = csv.DictReader(StringIO(response.text))
        mappings = []

        for row in reader:
            customer_id = row.get('customer_id', '').strip()
            driver_id = row.get('driver_id', '').strip()
            shift_start = row.get('shift_start', '').strip()
            shift_end = row.get('shift_end', '').strip()

            if customer_id and driver_id:
                mappings.append({
                    'customer_id': customer_id,
                    'driver_id': driver_id,
                    'first_name_last_name': row.get('first_name_last_name', '').strip(),
                    'shift_start': parse_time(shift_start),
                    'shift_end': parse_time(shift_end),
                    'driver_ids': [driver_id],  # backward compatibility
                    'bot_token': row.get('bot_token', '').strip(),
                    'chat_id': row.get('chat_id', '').strip(),
                })

        return {
            'mappings': mappings,
            'poll_interval_seconds': DEFAULT_POLL_INTERVAL,
            'job_max_age_minutes': DEFAULT_JOB_MAX_AGE
        }
    except Exception as e:
        print(f"Error loading from sheets: {e}")
        return None


def get_unassigned_jobs(page=1, per_page=50):
    jobs_url = f"{BASE_URL}/jobs"
    params = {
        "filter[job_status_id]": 2,  # unassigned
        "page": page,
        "per_page": per_page
    }
    response = requests.get(jobs_url, headers=HEADERS, params=params, timeout=30)
    try:
        return response.json()
    except requests.exceptions.JSONDecodeError:
        return {"data": []}


def get_customer_id_from_job(job):
    stops = job.get('stops', [])
    for stop in stops:
        if stop.get('stop_type_id') == 1:
            return stop.get('customer_id')
    return None


def get_customer_name_from_job(job):
    """Try to get customer name from pickup stop"""
    stops = job.get('stops', [])
    for stop in stops:
        if stop.get('stop_type_id') == 1:
            return stop.get('customer_name') or stop.get('name') or stop.get('address', 'Unknown')
    return None


def is_driver_on_shift(mapping, job_time):
    """Check if driver is on shift at the given job creation time."""
    shift_start = mapping.get('shift_start')
    shift_end = mapping.get('shift_end')

    # If no shift times defined, driver is always available
    if shift_start is None or shift_end is None:
        return True

    job_time_only = job_time.time()

    # Overnight shifts (e.g., 22:00 - 06:00)
    if shift_start > shift_end:
        return job_time_only >= shift_start or job_time_only <= shift_end
    return shift_start <= job_time_only <= shift_end


def get_drivers_on_duty(config, customer_id, job_time):
    """
    Returns: (drivers_list, status)
    status:
      - 'happy'    exactly 1 driver on duty
      - 'clash'    multiple drivers on duty
      - 'no_driver' none on duty (but customer mapped)
      - 'no_mapping' customer not configured
    """
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
    """
    Assign job to driver. Tries first_name_last_name first if provided,
    falls back to driver_id (UUID) if that fails.
    Returns: (status_code, response_json, identifier_used)
    """
    payload = {"job_ids": [job_id]}

    # Try with first_name_last_name first if provided
    if first_name_last_name:
        encoded_name = quote_plus(first_name_last_name)
        assign_url = f"{BASE_URL}/jobs/assign/{encoded_name}"
        response = requests.put(assign_url, headers=HEADERS, json=payload, timeout=30)
        if response.status_code == 200:
            return response.status_code, response.json(), first_name_last_name

    # Fallback to UUID
    assign_url = f"{BASE_URL}/jobs/assign/{driver_id}"
    response = requests.put(assign_url, headers=HEADERS, json=payload, timeout=30)
    return response.status_code, response.json(), driver_id


def get_job_details(job_id):
    """Fetch full job details including stops with coordinates."""
    job_url = f"{BASE_URL}/jobs/{job_id}"
    response = requests.get(job_url, headers=HEADERS, timeout=30)
    try:
        return response.json()
    except requests.exceptions.JSONDecodeError:
        return {"data": {}}


def send_zalo_message(bot_token, chat_id, text):
    """Send a Zalo message to a driver."""
    if not bot_token or not chat_id:
        return None
    url = f"https://bot-api.zaloplatforms.com/bot{bot_token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    try:
        r = requests.post(url, json=payload, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def is_job_recent(job, max_age_minutes):
    create_ts = job.get('create_ts')
    if not create_ts:
        return False
    try:
        job_time = datetime.strptime(create_ts, "%Y-%m-%d %H:%M:%S")
        cutoff_time = datetime.now() - timedelta(minutes=max_age_minutes)
        return job_time >= cutoff_time
    except ValueError:
        return False


def job_has_notes(job):
    """
    Skip job if any stop has a note.
    Exception: note == "Call before delivery" is allowed.
    """
    stops = job.get('stops', [])
    for stop in stops:
        note = stop.get('note')
        if note and str(note).strip():
            if str(note).strip() == "Call before delivery":
                continue
            return True
    return False


def build_gmaps_route_link(stop1_lat, stop1_lng, stop2_lat, stop2_lng):
    """
    Google Maps directions link:
      Current Location -> Stop 1 -> Stop 2
      Motorbike mode.
    """
    if stop1_lat is None or stop1_lng is None or stop2_lat is None or stop2_lng is None:
        return None

    # For mobile: makes Google Maps use device GPS as origin
    saddr = quote_plus("Current Location")

    # Use +to: syntax for multi-stop route: origin -> stop1 -> stop2
    return (
        "https://maps.google.com/maps?"
        "directionsmode=motorbike"
        f"&saddr={saddr}"
        f"&daddr={stop1_lat},{stop1_lng}+to:{stop2_lat},{stop2_lng}"
    )


# =========================
# UI App
# =========================
FONT_UI = "Helvetica Neue" if platform.system() == "Darwin" else "Segoe UI"
FONT_MONO = "Menlo" if platform.system() == "Darwin" else "Consolas"


class AutoAssignApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Auto-Assign Service")
        self.root.geometry("700x500")
        self.root.configure(bg="#f0f0f0")

        self.running = False
        self.config = None
        self.worker_thread = None

        self.setup_ui()
        self.refresh_config()

    def setup_ui(self):
        # Header
        header = tk.Frame(self.root, bg="#2c3e50", height=60)
        header.pack(fill=tk.X)
        header.pack_propagate(False)

        title = tk.Label(
            header,
            text="Auto-Assign Service",
            font=(FONT_UI, 16, "bold"),
            fg="white",
            bg="#2c3e50",
        )
        title.pack(pady=15)

        # Status bar
        self.status_frame = tk.Frame(self.root, bg="#27ae60", height=30)
        self.status_frame.pack(fill=tk.X)
        self.status_frame.pack_propagate(False)

        self.status_label = tk.Label(
            self.status_frame,
            text="Ready",
            font=(FONT_UI, 10),
            fg="white",
            bg="#27ae60",
        )
        self.status_label.pack(pady=5)

        # Main content
        content = tk.Frame(self.root, bg="#f0f0f0", padx=20, pady=10)
        content.pack(fill=tk.BOTH, expand=True)

        # Log section
        log_label = tk.Label(content, text="Activity Log", font=(FONT_UI, 11, "bold"), bg="#f0f0f0")
        log_label.pack(anchor=tk.W)

        self.log_text = scrolledtext.ScrolledText(
            content,
            height=12,
            font=(FONT_MONO, 9),
            wrap=tk.WORD,
            bg="white",
        )
        self.log_text.pack(fill=tk.BOTH, expand=True, pady=5)

        # Log tags
        self.log_text.tag_config("success", foreground="#27ae60")
        self.log_text.tag_config("error", foreground="#e74c3c")
        self.log_text.tag_config("warning", foreground="#f39c12")
        self.log_text.tag_config("info", foreground="#3498db")
        self.log_text.tag_config("time", foreground="#7f8c8d")

        self.link_urls = {}

        # Buttons
        btn_frame = tk.Frame(self.root, bg="#f0f0f0", pady=15)
        btn_frame.pack(fill=tk.X)

        self.start_btn = tk.Button(
            btn_frame,
            text="▶ Start",
            font=(FONT_UI, 11, "bold"),
            bg="#27ae60",
            fg="white",
            width=12,
            height=2,
            command=self.start_service,
            cursor="hand2",
        )
        self.start_btn.pack(side=tk.LEFT, padx=(20, 10))

        self.stop_btn = tk.Button(
            btn_frame,
            text="■ Stop",
            font=(FONT_UI, 11, "bold"),
            bg="#e74c3c",
            fg="white",
            width=12,
            height=2,
            command=self.stop_service,
            state=tk.DISABLED,
            cursor="hand2",
        )
        self.stop_btn.pack(side=tk.LEFT, padx=10)

        self.refresh_btn = tk.Button(
            btn_frame,
            text="⟳ Refresh Config",
            font=(FONT_UI, 11, "bold"),
            bg="#06a0f8",
            fg="white",
            width=16,
            height=2,
            relief=tk.SOLID,
            bd=1,
            cursor="hand2",
            command=self.refresh_config,
        )
        self.refresh_btn.pack(side=tk.LEFT, padx=10)

        info_text = f"Poll: {DEFAULT_POLL_INTERVAL}s | Job max age: {DEFAULT_JOB_MAX_AGE} min"
        info_label = tk.Label(btn_frame, text=info_text, font=(FONT_UI, 9), fg="#7f8c8d", bg="#f0f0f0")
        info_label.pack(side=tk.RIGHT, padx=20)

    def refresh_config(self):
        """Reload mappings from Google Sheets."""
        self.refresh_btn.config(state=tk.DISABLED, text="loading...")

        def fetch():
            self.config = load_config_from_sheets()
            self.root.after(0, self._on_config_loaded)

        threading.Thread(target=fetch, daemon=True).start()

    def _on_config_loaded(self):
        self.refresh_btn.config(state=tk.NORMAL, text="⟳ Refresh Config")
        if self.config:
            self.log(f"Config loaded: {len(self.config.get('mappings', []))} mapping(s)", "success")
        else:
            self.log("Failed to load config from Google Sheets", "error")

    def log(self, message, tag="info"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.insert(tk.END, f"[{timestamp}] ", "time")

        # Parse markdown links: [text](url)
        link_pattern = r'\[([^\]]+)\]\(([^)]+)\)'
        last_end = 0

        for match in re.finditer(link_pattern, message):
            if match.start() > last_end:
                self.log_text.insert(tk.END, message[last_end:match.start()], tag)

            link_text = match.group(1)
            link_url = match.group(2)
            link_tag = f"link_{len(self.link_urls)}"
            self.link_urls[link_tag] = link_url

            self.log_text.tag_config(link_tag, foreground="#0066cc", underline=True)
            self.log_text.tag_bind(link_tag, "<Button-1>", lambda e, url=link_url: webbrowser.open(url))
            self.log_text.tag_bind(link_tag, "<Enter>", lambda e: self.log_text.config(cursor="hand2"))
            self.log_text.tag_bind(link_tag, "<Leave>", lambda e: self.log_text.config(cursor=""))
            self.log_text.insert(tk.END, link_text, link_tag)

            last_end = match.end()

        if last_end < len(message):
            self.log_text.insert(tk.END, message[last_end:], tag)

        self.log_text.insert(tk.END, "\n")
        self.log_text.see(tk.END)

    def set_status(self, text, color):
        self.status_label.config(text=text)
        self.status_frame.config(bg=color)
        self.status_label.config(bg=color)

    def start_service(self):
        if not self.config:
            self.log("Cannot start: config not loaded!", "error")
            return

        self.running = True
        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.set_status("Running", "#27ae60")
        self.log("Service started", "success")

        self.worker_thread = threading.Thread(target=self.run_loop, daemon=True)
        self.worker_thread.start()

    def stop_service(self):
        self.running = False
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.set_status("Stopped", "#e74c3c")
        self.log("Service stopped", "error")

    def run_loop(self):
        poll_interval = self.config.get('poll_interval_seconds', DEFAULT_POLL_INTERVAL)

        while self.running:
            self.root.after(0, lambda: self.log("Checking for unassigned jobs...", "info"))
            self.auto_assign()

            for _ in range(poll_interval):
                if not self.running:
                    break
                time.sleep(1)

    def auto_assign(self):
        try:
            jobs_data = get_unassigned_jobs()
            jobs = jobs_data.get("data", [])
        except Exception as e:
            self.root.after(0, lambda: self.log(f"Error fetching jobs: {e}", "error"))
            return

        if not jobs:
            self.root.after(0, lambda: self.log("No unassigned jobs", "info"))
            return

        max_age = self.config.get('job_max_age_minutes', DEFAULT_JOB_MAX_AGE)
        jobs = [j for j in jobs if is_job_recent(j, max_age)]

        if not jobs:
            self.root.after(0, lambda: self.log(f"No jobs within last {max_age} min", "info"))
            return

        self.root.after(0, lambda: self.log(f"Found {len(jobs)} recent job(s)", "info"))

        for job in jobs:
            job_id = job.get('job_id')
            customer_id = get_customer_id_from_job(job)
            job_customer_name = get_customer_name_from_job(job)

            # Skip jobs where any stop has a note
            if job_has_notes(job):
                msg = f"Job {job_id} - SKIPPED: stop has note"
                self.root.after(0, lambda m=msg: self.log(m, "info"))
                continue

            if not customer_id:
                msg = f"Job {job_id} - No pickup stop found"
                self.root.after(0, lambda m=msg: self.log(m, "error"))
                continue

            # Parse job creation time for shift checking
            create_ts = job.get('create_ts')
            try:
                job_time = datetime.strptime(create_ts, "%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError):
                job_time = datetime.now()

            drivers, status = get_drivers_on_duty(self.config, customer_id, job_time)

            if status == 'no_mapping':
                msg = f"Job {job_id} - NO MAPPING: customer {customer_id} not configured"
                self.root.after(0, lambda m=msg: self.log(m, "error"))
                continue

            if status == 'no_driver':
                shift_info = []
                for m in drivers:
                    shift_str = f"{m.get('shift_start', '?')}-{m.get('shift_end', '?')}"
                    shift_info.append(f"{m.get('driver_id')} ({shift_str})")
                msg = f"Job {job_id} - NO DRIVER ON DUTY at {job_time.strftime('%H:%M')} | Configured: {', '.join(shift_info)}"
                self.root.after(0, lambda m=msg: self.log(m, "error"))
                continue

            if status == 'clash':
                driver_list = [f"{m.get('driver_id')} ({m.get('shift_start')}-{m.get('shift_end')})" for m in drivers]
                msg = f"Job {job_id} - CLASH: {len(drivers)} drivers on duty at {job_time.strftime('%H:%M')}: {', '.join(driver_list)}"
                self.root.after(0, lambda m=msg: self.log(m, "warning"))
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
                    # Fetch full job details to get stops with coordinates
                    job_details = get_job_details(job_id)
                    data = job_details.get('data', {})
                    resp_job_id = job_id

                    # Stops parsing (for names + GPS)
                    stops = data.get('stops', [])

                    # Friendly names
                    pickup_name = 'N/A'
                    dropoff_name = 'N/A'
                    if len(stops) >= 1:
                        pickup_name = stops[0].get('customer_name', 'N/A')
                    if len(stops) >= 2:
                        dropoff_name = stops[1].get('customer_name', 'N/A')

                    # Driver name
                    driver_data = data.get('driver', {})
                    resp_driver_name = f"{driver_data.get('first_name', '')} {driver_data.get('last_name', '')}".strip() or 'N/A'

                    # Log line (clickable job url)
                    job_url = f"https://fleetweb-vn.cartrack.com/delivery/map?job={resp_job_id}"
                    msg = f"✓ Job [{resp_job_id}]({job_url}) | {resp_driver_name} → {pickup_name}"
                    self.root.after(0, lambda m=msg: self.log(m, "success"))

                    # Build Google Maps route link: Current -> Stop1 -> Stop2
                    route_link = None
                    if len(stops) >= 2:
                        stop1_lat = stops[0].get('latitude')
                        stop1_lng = stops[0].get('longitude')
                        stop2_lat = stops[1].get('latitude')
                        stop2_lng = stops[1].get('longitude')
                        route_link = build_gmaps_route_link(stop1_lat, stop1_lng, stop2_lat, stop2_lng)

                    # Send Zalo notification with route link
                    bot_token = mapping.get('bot_token')
                    chat_id = mapping.get('chat_id')
                    if bot_token and chat_id:
                        zalo_lines = [
                            f"New job assigned: {resp_job_id}",
                            f"Pickup (Stop 1): {pickup_name if pickup_name != 'N/A' else (job_customer_name or 'N/A')}",
                            f"Dropoff (Stop 2): {dropoff_name}",
                        ]
                        if route_link:
                            zalo_lines.append(f"Route (motorbike): {route_link}")
                        else:
                            zalo_lines.append("Route: (missing coordinates)")

                        zalo_text = "\n".join(zalo_lines)

                        zalo_result = send_zalo_message(bot_token, chat_id, zalo_text)
                        if zalo_result:
                            self.root.after(0, lambda: self.log("Zalo notification sent", "info"))

                else:
                    error_msg = response.get('message', str(response))
                    msg = f"✗ Job {job_id} failed: {error_msg}"
                    self.root.after(0, lambda m=msg: self.log(m, "error"))

            except Exception as e:
                msg = f"✗ Job {job_id} error: {e}"
                self.root.after(0, lambda m=msg: self.log(m, "error"))


# =========================
# Entry point
# =========================
def main():
    root = tk.Tk()
    AutoAssignApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
