import { readFileSync, writeFileSync } from "node:fs";
import { decryptAudit } from "./payroll-audit-crypto";

const [encryptedPath, privateKeyPath, outputPath] = process.argv.slice(2);
if (!encryptedPath || !privateKeyPath || !outputPath) throw new Error("Usage: payroll-audit-decrypt.mts <encrypted audit> <operator private key> <restricted output>");
const plaintext = decryptAudit(JSON.parse(readFileSync(encryptedPath, "utf8")), readFileSync(privateKeyPath, "utf8"));
writeFileSync(outputPath, `${plaintext}\n`, { mode: 0o600 });
console.log("Audit decrypted into the restricted operator directory.");
