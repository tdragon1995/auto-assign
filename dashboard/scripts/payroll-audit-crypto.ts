import { createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes, constants } from "node:crypto";

interface Envelope { version: 1; key: string; iv: string; tag: string; ciphertext: string }

/** Hybrid authenticated encryption: only the payroll operator holds the private
 * key. The runner receives a public key and uploads ciphertext only. */
export function encryptAudit(plaintext: string, publicKey: string): Envelope {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { version: 1, key: wrapped.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function decryptAudit(envelope: Envelope, privateKey: string): string {
  if (envelope.version !== 1) throw new Error("Unsupported encrypted audit");
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.key, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, "base64")), cipher.final()]).toString("utf8");
}
