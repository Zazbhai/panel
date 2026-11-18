"use strict";

const assert = require("node:assert/strict");
const { matchServiceMessage } = require("../service-matching-core");

const swiggy = {
  name: "Swiggy",
  minOtpLength: 4,
  maxOtpLength: 8,
  senderFilter: "",
  templates: [{
    text: "This is a Swiggy login OTP. Do not share the OTP or your number with anyone including Swiggy Personnel through message or call. Your OTP {{OTP}} to log into Swiggy account.",
    enabled: true
  }]
};
const jio = {
  name: "credentials",
  minOtpLength: 6,
  maxOtpLength: 6,
  senderFilter: "",
  templates: [{
    text: "{{OTP}} is your One time password (OTP) to login to MyJio. Don't share OTP with anyone.",
    enabled: true
  }]
};
const senderScoped = {
  name: "Sender scoped",
  minOtpLength: 6,
  maxOtpLength: 6,
  senderFilter: "VM-SWIGGY",
  templates: [{ text: "Use code {{OTP}} to continue.", enabled: true }]
};

const jioText = "989099 is your One time password (OTP) to login to MyJio. Don't share OTP with anyone.";
const swiggyText = "This is a Swiggy login OTP. Do not share the OTP or your number with anyone including Swiggy Personnel through message or call. Your OTP 989099 to log into Swiggy account.";
const flipkart = {
  name: "Flipkart",
  minOtpLength: 4,
  maxOtpLength: 8,
  senderFilter: "",
  templates: [{
    text: "LOGIN to your Flipkart account using OTP {{OTP}}. DO NOT SHARE this code with anyone, including delivery agents. #{{OTP}}",
    enabled: true
  }]
};
const flipkartText = "LOGIN to your Flipkart account using OTP 634435. DO NOT SHARE this code with anyone, including delivery agents. #634435";
const genericText = "Your OTP is 989099.";
const whatsapp = {
  name: "WhatsApp",
  minOtpLength: 6,
  maxOtpLength: 6,
  senderFilter: "",
  templates: [{ text: "Your WhatsApp code: [OTP]", enabled: true }]
};
const whatsappText = "<#> Your WhatsApp account is being registered on a new device Do not share this code with anyone Your WhatsApp code: 661-572 4sgLq1p5sV6";

assert.deepEqual(matchServiceMessage(jio, jioText, { sender: "VM-JIO" }), { code: "989099" });
assert.equal(matchServiceMessage(swiggy, jioText, { sender: "VM-JIO" }), null);
assert.equal(matchServiceMessage(jio, swiggyText, { sender: "VM-SWIGGY" }), null);
assert.equal(matchServiceMessage(swiggy, genericText, { sender: "VM-SWIGGY" }), null);
assert.equal(matchServiceMessage(senderScoped, "Use code 989099 to continue.", { sender: "VM-JIO" }), null);
assert.deepEqual(matchServiceMessage(senderScoped, "Use code 989099 to continue.", { sender: "VM-SWIGGY" }), { code: "989099" });
assert.equal(matchServiceMessage(jio, "98909 is your One time password (OTP) to login to MyJio. Don't share OTP with anyone.", {}), null);
assert.deepEqual(matchServiceMessage(flipkart, flipkartText, { sender: "VA-FL-PKRT-S" }), { code: "634435" });
assert.deepEqual(matchServiceMessage(whatsapp, whatsappText), { code: "661572" });
const digitMarkerService = { templates: [{ text: "Account [DIGITS:3] code [OTP]", enabled: true }] };
assert.deepEqual(matchServiceMessage(digitMarkerService, "Account 123 code 654321"), { code: "654321" });
assert.equal(matchServiceMessage(digitMarkerService, "Account 12 code 654321"), null);
assert.equal(matchServiceMessage(flipkart, flipkartText.replace("#634435", "#999999")), null);
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "service-matching.js"), "utf8"), browser);
for (const [service, text] of [
  [digitMarkerService, "Account 123 code 654321"],
  [digitMarkerService, "Account 12 code 654321"],
  [flipkart, flipkartText], [flipkart, flipkartText.replace("#634435", "#999999")],
  [swiggy, jioText], [whatsapp, whatsappText]
]) {
  assert.equal(browser.window.serviceMatching.matches(service, text), Boolean(matchServiceMessage(service, text)));
}
console.log("PASS: service-scoped OTP matching rejects Jio/Swiggy cross-matches, generic OTPs, wrong senders and wrong code lengths.");
