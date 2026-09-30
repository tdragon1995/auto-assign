import assert from "node:assert/strict";
import { profilePatch } from "../src/components/master-profile-editor";

const client = { address_line_1: "Old", latitude: 10.5, longitude: 106.5 };
const draft = { address_line_1: "New", latitude: "11", longitude: "107", bot_token: "not writable" };
assert.deepEqual(profilePatch("client", client, draft, true), { address_line_1: "New" });
assert.deepEqual(profilePatch("client", client, draft, false), { address_line_1: "New", latitude: 11, longitude: 107 });
assert.throws(() => profilePatch("client", client, { latitude: "invalid" }, false));
assert.deepEqual(profilePatch("driver", { shift_time_start: "07:00:00+07:00" }, { shift_time_start: "07:00", bot_token: "not writable" }, true), {});
assert.deepEqual(profilePatch("driver", {}, { shift_time_start: "08:30", end_location_customer_id: "" }, true), { shift_time_start: "08:30:00+07:00" });
assert.deepEqual(profilePatch("driver", { end_location_customer_id: "old", shift_time_end: "18:00" }, { end_location_customer_id: "", shift_time_end: "" }, true), { end_location_customer_id: null, shift_time_end: null });
console.log("Profile edit checks passed: locked GPS, credential exclusion, numeric validation and local shift times");
