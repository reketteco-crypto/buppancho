import { hash, verify, type Options } from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  // @node-rs/argon2 declares Algorithm as an ambient const enum, which cannot
  // be referenced with isolatedModules. Its documented Argon2id value is 2.
  algorithm: 2,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
