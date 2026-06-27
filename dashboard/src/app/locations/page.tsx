"use client";

import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// PSC routes are a hard-coded constant ([[psc-routes-data]]); import directly instead of
// fetching /api/psc-routes — no function invocation, no network round-trip, instant render.
import { PSC_ROUTES } from "@/lib/psc-routes-data";

export default function LocationsPage() {
  const routes = PSC_ROUTES;
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="min-h-screen bg-background p-4 sm:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">
            PSC Pickup Locations
          </h1>
          <p className="text-muted-foreground mt-1">
            {routes.length} route(s) loaded. Scan a QR code to preview & assign
            the job.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {routes.map((route) => {
            const code = route.pickup;
            const qrUrl = `${baseUrl}/qr/${code}`;

            return (
              <Card key={code} className="relative">
                <CardHeader className="pb-2">
                  <CardTitle>
                    <span>{route.psc_pickup}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col items-center gap-3">
                  <a href={`/qr/${code}`}>
                    <QRCodeSVG
                      value={qrUrl}
                      size={160}
                      level="M"
                      className="rounded"
                    />
                  </a>
                  <div className="w-full text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Route</span>
                      <span className="font-medium">
                        {route.psc_pickup} &#x27A1; {route.dropoff_location}
                      </span>
                    </div>
                    {route.ref_number && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Ref</span>
                        <span className="font-mono text-xs">
                          {route.ref_number}
                        </span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
