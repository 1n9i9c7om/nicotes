import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/** Just enough CBOR for WebAuthn: unsigned and negative ints, byte and text strings, maps. */
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}
interface RequestOptions {
  challenge: string;
  rpId?: string;
}

/** A passkey in software: an ES256 key pair answering like a browser would. */
export class SoftAuthenticator {
  private keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = b64url(randomBytes(16));
  private counter = 0;
  private userHandle = '';

  constructor(private backedUp = false) {}

  register(options: CreationOptions, origin: string) {
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const id = Buffer.from(this.credentialId, 'base64url');
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(options.rp.id ?? new URL(origin).hostname),
      Buffer.from([0x45 | (this.backedUp ? 0x18 : 0)]), // user present + verified + attested data (+ backup)
      Buffer.alloc(4), // counter 0
      Buffer.alloc(16), // AAGUID
      idLength,
      id,
      cbor(coseKey),
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  authenticate(options: RequestOptions, origin: string, rpId = options.rpId ?? new URL(origin).hostname) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([0x05]), counter]);
    const clientData = JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false });
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.keys.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
