"use client";

import { MapContainer, TileLayer, CircleMarker, Popup, Polyline } from "react-leaflet";
import type { Driver, Job } from "@/lib/types";
import { DRIVER_STATUS_CONFIG } from "@/lib/types";
import "leaflet/dist/leaflet.css";

interface FleetMapInnerProps {
  drivers: Driver[];
  jobs: Job[];
}

const HCM_CENTER: [number, number] = [10.8231, 106.6297];

export default function FleetMapInner({ drivers, jobs }: FleetMapInnerProps) {
  const driversWithPos = drivers.filter(
    (d) => d.latitude != null && d.longitude != null
  );

  return (
    <MapContainer
      center={HCM_CENTER}
      zoom={12}
      className="h-full w-full rounded-lg"
      style={{ minHeight: "400px" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Driver markers */}
      {driversWithPos.map((driver) => {
        const status = DRIVER_STATUS_CONFIG[driver.driver_status_id] ?? {
          name: "Unknown",
          color: "#7f8c8d",
        };
        const name = `${driver.first_name} ${driver.last_name}`.trim() || "Unknown";

        return (
          <CircleMarker
            key={driver.delivery_driver_id}
            center={[driver.latitude!, driver.longitude!]}
            radius={8}
            pathOptions={{
              color: "white",
              weight: 2,
              fillColor: status.color,
              fillOpacity: 0.9,
            }}
          >
            <Popup>
              <div className="text-xs space-y-1">
                <p className="font-bold text-sm">{name}</p>
                <p>
                  Status:{" "}
                  <span style={{ color: status.color, fontWeight: "bold" }}>
                    {status.name}
                  </span>
                </p>
                <p>Phone: {driver.phone_number ?? "N/A"}</p>
                <p>
                  Online: {driver.is_online ? "Yes" : "No"} | Active:{" "}
                  {driver.is_active ? "Yes" : "No"}
                </p>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {/* Job markers & route lines */}
      {jobs.map((job) => {
        const stops = job.stops ?? [];
        const validStops = stops.filter(
          (s) => s.latitude != null && s.longitude != null
        );

        return (
          <span key={job.job_id}>
            {validStops.map((stop, idx) => (
              <CircleMarker
                key={`${job.job_id}-${idx}`}
                center={[stop.latitude!, stop.longitude!]}
                radius={6}
                pathOptions={{
                  color: idx === 0 ? "#e74c3c" : "#8e44ad",
                  weight: 2,
                  fillColor: idx === 0 ? "#e74c3c" : "#8e44ad",
                  fillOpacity: 0.7,
                }}
              >
                <Popup>
                  <div className="text-xs space-y-1">
                    <p className="font-bold">
                      Job {job.job_id} - {idx === 0 ? "Pickup" : "Dropoff"}
                    </p>
                    <p>{stop.customer_name ?? stop.address ?? "N/A"}</p>
                  </div>
                </Popup>
              </CircleMarker>
            ))}

            {/* Route line between stops */}
            {validStops.length >= 2 && (
              <Polyline
                positions={validStops.map(
                  (s) => [s.latitude!, s.longitude!] as [number, number]
                )}
                pathOptions={{
                  color: "#9b59b6",
                  weight: 2,
                  dashArray: "5, 5",
                  opacity: 0.6,
                }}
              />
            )}
          </span>
        );
      })}
    </MapContainer>
  );
}
