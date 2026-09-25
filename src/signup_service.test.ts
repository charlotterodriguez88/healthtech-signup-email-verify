import assert from "node:assert/strict";
import { notificationForAppointment } from "./signup_service.js";

const notification = notificationForAppointment({ name: "Mina", appointmentType: "nutrition", verificationUrl: "https://clinic.test/verify/token" });
assert.equal(notification.subject, "Verify your appointment account");
assert.match(notification.html, /nutrition/);
assert.match(notification.html, /https:\/\/clinic\.test\/verify\/token/);
console.log("notification decision test passed");
