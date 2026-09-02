const crypto = require("crypto");

const HASH_PREFIX = "scrypt";
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(
    String(password),
    salt,
    KEY_LENGTH,
    SCRYPT_OPTIONS
  );

  return [
    HASH_PREFIX,
    salt.toString("base64url"),
    derivedKey.toString("base64url")
  ].join("$");
}

function isPasswordHash(value) {
  return typeof value === "string" && value.startsWith(`${HASH_PREFIX}$`);
}

function verifyPassword(password, storedValue) {
  if (!isPasswordHash(storedValue)) {
    return String(storedValue ?? "") === String(password ?? "");
  }

  try {
    const parts = storedValue.split("$");

    if (parts.length !== 3 || parts[0] !== HASH_PREFIX) {
      return false;
    }

    const expected = Buffer.from(parts[2], "base64url");
    const actual = crypto.scryptSync(
      String(password),
      Buffer.from(parts[1], "base64url"),
      expected.length,
      SCRYPT_OPTIONS
    );

    return expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual);
  } catch (error) {
    return false;
  }
}

module.exports = {
  hashPassword,
  isPasswordHash,
  verifyPassword
};
