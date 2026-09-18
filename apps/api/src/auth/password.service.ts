import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id (the library default) with the OWASP-recommended minimum profile:
 * 19 MiB memory, 2 iterations, 1 lane. Output is a self-describing PHC string, so parameters can
 * be raised later without invalidating existing hashes.
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  /** Returns false (never throws) for wrong passwords and for malformed stored hashes. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Verify against `passwordHash` if there is one, otherwise against a throwaway hash, so the
   * response time of "unknown email" matches "wrong password" and cannot reveal which accounts exist.
   */
  async verifyOrDummy(passwordHash: string | undefined, password: string): Promise<boolean> {
    if (passwordHash) return this.verify(passwordHash, password);
    this.dummyHash ??= this.hash('nexus-timing-equaliser-not-a-real-password');
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
