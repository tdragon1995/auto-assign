import { LocationsPanel } from "@/components/locations-panel";

// Also shown as the "Địa điểm PSC" tab on the admin dashboard.
export default function LocationsPage() {
  return (
    <div className="min-h-screen bg-background p-4 sm:p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold tracking-tight mb-1">PSC Pickup Locations</h1>
        <LocationsPanel />
      </div>
    </div>
  );
}
