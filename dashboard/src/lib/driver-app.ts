/**
 * Cartrack Driver App login — the same `driver_app_login` RPC the Android app
 * (com.cartrack.driverapp) calls to validate a driver's phone + PIN. Used by the
 * self-service "Tài xế" module so a driver can prove identity before claiming
 * jobs mapped to their smart_driver_id.
 *
 * Reverse-engineered from the v2.4.02 APK (version code 472) and corrected
 * against live VN responses (2026-07-16).
 *
 * ── SUCCESS RULE (do NOT "fix" to errorCode === 0) ────────────────────────────
 *   A real successful login returns `errorCode: 1`, `error: null`, and a
 *   populated `result` (driverID + serverHash). We treat a login as valid iff
 *   `error` is falsy AND `result.driverID` is present.
 *
 * ── TWO-STAGE LOGIN (errorCode 169 = concurrent-session challenge) ────────────
 *   If the driver already has an active session (e.g. their phone app), stage 1
 *   returns `errorCode: 169` with `result: null` and a challenge UUID in the
 *   `error` field (NOT the serverHash; the top-level `hash` on this response is
 *   also NOT the serverHash). The app answers by echoing that UUID back in
 *   `params[0].sessionHash` and repeating the login; stage 2 then returns the
 *   real LoginResultDto. We replicate that exactly, once.
 *
 *   ⚠️ Completing stage 2 establishes a NEW authenticated session and will very
 *   likely invalidate the driver's existing (phone) session — "log in here =
 *   log out there." That is inherent to taking over the session; discarding the
 *   serverHash does not prevent it. If you need to validate WITHOUT taking over,
 *   see validateDriverIdentityOnly() below.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────────
 *   Never log `phoneNumber`, `pin`, the sessionHash challenge, or `serverHash`.
 *   This module reads driverID/driverName and DISCARDS serverHash — /tai-xe
 *   validates identity, it does not hold a driver session. If you ever need to
 *   persist serverHash, see the storage guidance in the module notes.
 */

// APK fallback is driverapp-eu; VN uses the -vn host (confirmed reachable, matches
// the fleetapi-vn / fleetweb-vn pattern). Overridable without a redeploy.
const DRIVER_APP_URL =
  process.env.CARTRACK_DRIVER_APP_URL ??
  "https://driverapp-vn.cartrack.com/driverappapi/src/public/index.php";

// VN country selector. Overridable in case Firebase Country config differs.
const DRIVER_APP_COUNTRY = process.env.CARTRACK_DRIVER_APP_COUNTRY ?? "VN";

// Synthetic device identity — this is a web validator, not a real handset. Kept
// constant so we present a stable "device" to Cartrack rather than a real
// Settings.Secure.android_id.
const WEB_DEVICE = "diag-web-validator";

const CONCURRENT_SESSION_CODE = 169;

// ── Response types (authoritative field list from observed VN responses) ──────
// NOTE: the nested config objects marked "shape TBD" were reported present in the
// live payload but their internal fields were not captured here — typed loosely
// until a raw sample is available. None of them are needed by /tai-xe.

export interface CarpoolConfig {
  hasCarpool: boolean;
  locationAllowed: boolean | null;
  purposeAllowed: boolean | null;
  canBookAutoBooking: boolean | null;
  canBookSpecificVehicle: boolean | null;
  driversCanSeeOtherDrivers: boolean | null;
  canExtendBooking: boolean | null;
  hasPolling: boolean;
  // NOTE: these two arrive as STRINGS in the live payload (e.g. "-1", "721"),
  // not numbers — do not `typeof === "number"` them.
  maxBookingInterval: string | null;
  maxBookingTime: string;
  cooldownLess24H: number;
  cooldownMore24H: number;
  driverCanStartBookingUpTo: number | null;
  booking_form: number | null;
}

export interface OperationConfig {
  hasOperations: boolean;
  formOptions?: unknown[] | null; // absent in the observed success payload
}

/** Absent from the observed delivery-driver payload (hasVoice: 0). Present only
 *  when voice is enabled. */
export interface VoiceConfigs {
  agoraUniqueID: number;
  voiceAppID: string | null;
}

/** Flat map of driver-app feature flags. Values are boolean presence-flags,
 *  except a few label/URL fields that are string|null. Index signature kept for
 *  forward-compat with flags not in this sample. Unused by /tai-xe. */
export interface AppSettingConfigs {
  defaultTimezone: boolean;
  driverCarbonFootprint: boolean;
  driverEcoScore: boolean;
  hasDvir: boolean;
  listMaintenance: boolean;
  driverAppHasSystemCheck: boolean;
  driverAppHasCarpool: boolean;
  carpool: boolean;
  driverAppHasCarpoolPooling: boolean;
  driverAppHasPathways: boolean;
  driverAppOperations: boolean;
  smsPrivacyNotification: boolean;
  driverHasHeartbeat: boolean;
  driverHeartbeatInterval: boolean;
  // Governs whether a new session login closes the existing one — related to the
  // errorCode-169 concurrent-session challenge. false in this sample.
  driverAppClosedNewSessionLogin: boolean;
  driverAppIdleTimeout: boolean;
  driverAppAutologoutIdle: boolean;
  driverAppMaxPhotoUploadCount: boolean;
  driverAppShowSupport: boolean;
  driverAppMenuLabelForms: boolean;
  driverAppMenuLabelBooking: boolean;
  driverAppMenuLabelGuide: boolean;
  facilityModuleNameType: boolean;
  driverAppLabelCancelBooking: string | null;
  driverAppShowMyCurrentVehicle: boolean | null;
  driverAppShowOnlyCarpoolVehicles: boolean;
  driverAppPreDriveHasCriticalEnabled: boolean;
  ruc: boolean;
  ruk: string | null;
  driverAppHistoryDateFilterDaysAgo: boolean;
  driverAppScheduledDateFilterDays: boolean;
  hideDriverData: boolean;
  delivery: boolean;
  fieldService: boolean;
  costs: boolean;
  countryHasMobileCosts: boolean;
  tachographIdhaApiUrl: string | null;
  tachographInfractions: boolean;
  privacy: boolean;
  [key: string]: boolean | string | null;
}

export interface RoutesConfig {
  manualStopConfirmationAllowOutside: boolean;
  navigationEnabled: boolean;
  navigationAppName: string | null;
  navigationDeeplink: string | null;
  startOffsetTimeSeconds: number;
  endOffsetTimeSeconds: number;
}

export interface LoginResultDto {
  username: string | null;
  driverID: string | null;
  driverName: string | null;
  /** Authenticated session token — SECRET. Never log or return to a client. */
  serverHash: string | null;
  phoneModel: string | null;
  userID: number;
  clientUserID: number | null;

  // Observed as a number sentinel (-1) for a driver with no default vehicle;
  // may be a real id (string) otherwise.
  defaultVehicleID: number | string | null;
  defaultVehicleName: string | null;
  defaultVehicleRegistration: string | null;
  defaultVehicleMMM: string | null;
  defaultVehicleTypeID: number | null;
  lastEcoListHash: string | null;

  hasDelivery: boolean;
  hasFieldService: boolean;
  hasDVIR: boolean;
  hasEcoDriving: boolean;
  hasCosts: boolean;
  hasPrivacy: boolean;
  hasScorecards: boolean;
  hasSysCheck: boolean;
  hasTachographInfractions: boolean;
  hasRUC: boolean;
  hasCarbonFootprint: boolean;
  hasPaths: boolean;
  hasRoutes: boolean;
  isActiveDeliveryDriver: boolean;

  hasVoice: number | null;
  linkingMethods: number[] | null;
  carpoolConfigs: CarpoolConfig | null;
  operationConfigs: OperationConfig | null;
  voiceConfigs?: VoiceConfigs | null; // absent unless voice is enabled
  appSettingConfigs: AppSettingConfigs | null;
  routesConfig: RoutesConfig | null;
}

/** Generic RPC envelope. `errorCode` is NOT a reliable success discriminator
 *  (success = 1). On a 169 challenge, `error` carries the challenge UUID and
 *  `hash` is NOT the serverHash. */
export interface GenericDto<T> {
  id: number;
  error: string | null;
  errorCode: number;
  hash?: string | null;
  result: T | null;
}

export interface DriverLoginResult {
  ok: boolean;
  driverID: string | null;
  driverName: string | null;
  isActiveDeliveryDriver: boolean;
  /** Safe, human-readable reason when ok === false. Never contains secrets. */
  error: string | null;
  /** Raw errorCode for diagnostics (not a success discriminator). */
  errorCode: number | null;
}

// ── Low-level: one login call ─────────────────────────────────────────────────

function buildLoginBody(phoneNumber: string, pin: string, sessionHash: string | null) {
  return {
    id: 10,
    method: "driver_app_login",
    version: "2.0",
    lang: "vi",
    params: [
      {
        countryCode: DRIVER_APP_COUNTRY,
        countryLoginCode: DRIVER_APP_COUNTRY,
        phoneNumber,
        pin,
        os: 300,
        phoneOSTypeID: 1,
        phoneModel: "Web Validator",
        device_description: "Web Validator",
        device_name: "Web Validator",
        device_os: "Android",
        device_identifier: WEB_DEVICE,
        android_id: WEB_DEVICE,
        serverHash: "",
        sessionHash, // null on stage 1; challenge UUID on stage 2
        azureAuthenticationCode: "",
        fcmLogin: false,
        fcmToken: "",
        appVersion: "a_472",
        app_version: "2.4.02",
        phone_os_version: "a_472_15 (SDK 35)",
        devDB: false,
      },
    ],
  };
}

async function postLogin(
  phoneNumber: string,
  pin: string,
  sessionHash: string | null
): Promise<{ status: number; env: GenericDto<LoginResultDto> | null }> {
  const res = await fetch(DRIVER_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildLoginBody(phoneNumber, pin, sessionHash)),
    cache: "no-store",
  });
  const env = res.ok
    ? ((await res.json().catch(() => null)) as GenericDto<LoginResultDto> | null)
    : null;
  return { status: res.status, env };
}

// ── Result builders (kept tiny so no secret ever reaches a log or a client) ───

function fail(error: string, errorCode: number | null = null): DriverLoginResult {
  return { ok: false, driverID: null, driverName: null, isActiveDeliveryDriver: false, error, errorCode };
}

function finalize(env: GenericDto<LoginResultDto>): DriverLoginResult {
  const hasError = env.error != null && env.error !== "";
  const driverID = env.result?.driverID ?? null;

  if (!hasError && driverID) {
    return {
      ok: true,
      driverID,
      driverName: env.result?.driverName ?? null,
      isActiveDeliveryDriver: env.result?.isActiveDeliveryDriver === true,
      error: null,
      errorCode: env.errorCode ?? null,
    };
  }

  // Never surface the 169 challenge UUID as a user message.
  if (env.errorCode === CONCURRENT_SESSION_CODE) {
    return fail("Không hoàn tất đăng nhập. Vui lòng thử lại.", CONCURRENT_SESSION_CODE);
  }
  return fail(
    hasError ? String(env.error) : "Số điện thoại hoặc mã PIN không đúng.",
    env.errorCode ?? null
  );
}

// ── Public: two-stage login ───────────────────────────────────────────────────

/**
 * Validate a driver's phone + PIN, completing the 169 concurrent-session
 * challenge if presented. Returns identity (driverID/driverName) on success.
 * Throws only on a network/transport failure.
 *
 * ⚠️ On a 169 challenge this COMPLETES the login (stage 2), which takes over the
 * session and will likely log the driver out of their phone app. Use
 * validateDriverIdentityOnly() if you must avoid that.
 */
export async function validateDriverLogin(
  phoneNumber: string,
  pin: string
): Promise<DriverLoginResult> {
  // Stage 1
  let { status, env } = await postLogin(phoneNumber, pin, null);
  if (status < 200 || status >= 300) return fail(`Máy chủ Cartrack trả về lỗi (${status}).`);
  if (!env) return fail("Không đọc được phản hồi từ Cartrack.");

  // Stage 2 — answer the concurrent-session challenge exactly once.
  if (env.errorCode === CONCURRENT_SESSION_CODE) {
    const challenge = typeof env.error === "string" ? env.error.trim() : "";
    if (!challenge) return fail("Không hoàn tất đăng nhập (phiên đang hoạt động).", CONCURRENT_SESSION_CODE);
    ({ status, env } = await postLogin(phoneNumber, pin, challenge));
    if (status < 200 || status >= 300) return fail(`Máy chủ Cartrack trả về lỗi (${status}).`);
    if (!env) return fail("Không đọc được phản hồi từ Cartrack.");
    // A second 169 would mean the challenge wasn't accepted — bail, don't loop.
    if (env.errorCode === CONCURRENT_SESSION_CODE) {
      return fail("Không hoàn tất đăng nhập. Vui lòng thử lại.", CONCURRENT_SESSION_CODE);
    }
  }

  return finalize(env);
}

/**
 * Credential check that does NOT take over an existing session. Runs stage 1
 * only: a 169 challenge is itself proof the phone + PIN are valid (the server
 * issues it only after authenticating), so we treat 169 as "valid" WITHOUT
 * answering it — leaving the driver's phone session intact.
 *
 * Trade-off: on a 169 the `result` is null, so we get NO driverID/driverName
 * from this path. Callers that need identity must resolve it another way (e.g.
 * a phone→driver_id lookup) — otherwise use validateDriverLogin().
 */
export async function validateDriverIdentityOnly(
  phoneNumber: string,
  pin: string
): Promise<{ ok: boolean; driverID: string | null; driverName: string | null; error: string | null }> {
  const { status, env } = await postLogin(phoneNumber, pin, null);
  if (status < 200 || status >= 300) return { ok: false, driverID: null, driverName: null, error: `Máy chủ Cartrack trả về lỗi (${status}).` };
  if (!env) return { ok: false, driverID: null, driverName: null, error: "Không đọc được phản hồi từ Cartrack." };

  if (env.errorCode === CONCURRENT_SESSION_CODE) {
    // Valid credentials, existing session left untouched. No identity available.
    return { ok: true, driverID: null, driverName: null, error: null };
  }
  const r = finalize(env);
  return { ok: r.ok, driverID: r.driverID, driverName: r.driverName, error: r.error };
}
