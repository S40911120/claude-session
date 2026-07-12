'use strict';
/* Regression test: session-redact secret masking.
   Covers the JSON "key":"value" form a previous assignment rule missed (it required [=:] directly after
   the key word, which the JSON closing quote broke), plus the prefix-based token formats and a guard
   against over-masking ordinary text. */

const { redactString } = require('../session-redact');
const A = require('./_assert')('_redact');
const { ok, summary } = A;

console.log('[_redact.test.js]');

const masked = (s) => redactString(s).text.includes('REDACTED');
const unchanged = (s) => redactString(s).text === s;

// Assignment form (shell) — the previously-working path, must still mask
ok('shell password= masked', masked('password=hunter2secret'));
ok('shell password: masked', masked('password: hunter2secret'));
ok('shell api_key="..." masked', masked('api_key="abcd1234efgh"'));

// JSON "key":"value" form — the fix
ok('JSON "password":"..." masked', masked('{"password":"hunter2secret"}'));
ok('JSON "apiKey":"..." masked', masked('{"apiKey":"plainvalue1234"}'));
ok('JSON "access_token": "..." masked', masked('"access_token": "xyz12345"'));

// Prefix-based tokens (robust regardless of wrapping)
ok('anthropic/openai sk- masked', masked('sk-ant-abcdefghij1234567890'));
ok('github ghp_ masked', masked('ghp_abcdefghijklmnopqrstuvwxyz0123'));
ok('google AIza masked', masked('AIzaSyA1234567890abcdefghijklmnopqrstuv'));
ok('npm_ token masked', masked('npm_abcdefghijklmnopqrstuvwxyz0123456789'));

// Non-secrets must pass through untouched (no over-masking of ordinary text)
ok('plain sentence unchanged', unchanged('the quick brown fox jumps over'));
ok('short value not masked (< 4 chars)', unchanged('pwd=ab'));

// #2 over-masking prose: a bare `key: word` (colon separator, unquoted, no digit) is ordinary prose, not a
// secret — it must pass through untouched. The `=` form, a quoted value, and an entropy-ish (digit-bearing)
// value are unambiguous and still mask.
ok('#2 prose "token: myVariableName" unchanged', unchanged('set the token: myVariableName in config'));
ok('#2 prose "secret: solution" unchanged', unchanged('The secret: solution is here'));
ok('#2 real bare-colon secret (has digit) still masks', masked('password: hunter2secret'));
ok('#2 real token= assignment still masks', masked('token=abc123def456'));
ok('#2 quoted colon value still masks even without a digit', masked('password: "correcthorse"'));

// #1 escaped chars in a JSON secret: the value must MASK IN FULL (no verbatim leak) and stay valid JSON (no
// corruption). Round-5's [^"\\]{4,} stopped at the backslash, so the value class never reached a closing quote
// and the whole secret failed to match → emitted VERBATIM. Round-8's (?:[^"\\]|\\.){4,} consumes each escape as
// one unit, masks the full value, then stops at the REAL closing quote (the escaped char is swallowed).
const parses = (s) => { try { JSON.parse(redactString(s).text); return true; } catch { return false; } };
ok('#1 escaped-quote JSON secret masks the full value (no leak)', masked('{"password":"abc\\"def"}'));
ok('#1 escaped-quote JSON secret stays valid JSON (no corruption)', parses('{"password":"abc\\"def"}'));
ok('#1 escaped-backslash JSON secret masks the full value', masked('{"api_key":"pa\\\\ss1234"}'));
ok('#1 escaped-backslash JSON secret stays valid JSON', parses('{"api_key":"pa\\\\ss1234"}'));
ok('#1 Round-5 escaped-quote secret now masks (was leaking verbatim)', masked('{"password":"secret\\"value"}'));
ok('#1 Round-5 escaped-quote secret still stays valid JSON (no corruption)', parses('{"password":"secret\\"value"}'));
ok('#1 short JSON secret (< 4 units) still unchanged', unchanged('{"password":"a\\"b"}'));

// ── round-7 gap fixes: each new provider rule masks its secret + leaves a near-miss non-secret untouched ──

// D1 Azure Storage: AccountKey / SharedAccessKey base64 value + SAS sig=
ok('D1 AccountKey= masked', masked('AccountKey=' + 'a'.repeat(50) + '=='));
ok('D1 SharedAccessKey= masked', masked('SharedAccessKey=' + 'b'.repeat(44)));
ok('D1 SAS sig= masked', masked('https://x.blob.core.windows.net/c/b?sv=2021-06-08&sig=' + 'c'.repeat(64) + '%3D'));
ok('D1 near-miss AccountName= unchanged', unchanged('AccountName=mystorageaccount123'));
ok('D1 near-miss short sig= unchanged', unchanged('sig=abc'));
ok('D1 full Azure connection string stays valid JSON (no corruption)', parses('{"cs":"DefaultEndpointsProtocol=https;AccountName=foo;AccountKey=' + 'd'.repeat(60) + '==;EndpointSuffix=core.windows.net"}'));

// D2 Slack incoming-webhook URL + xapp- app-level token
ok('D2 slack webhook URL masked', masked('https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrstuvwx'));
ok('D2 slack xapp- token masked', masked('xapp-1-A012345678-012345678901-abcdef0123456789abcdef'));
ok('D2 near-miss api.slack.com docs URL unchanged', unchanged('https://api.slack.com/docs/messaging/webhooks'));
ok('D2 near-miss short xapp- unchanged', unchanged('xapp-conf'));

// D3 GCP OAuth client secret
ok('D3 GOCSPX- secret masked', masked('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5o'));
ok('D3 near-miss short GOCSPX- unchanged', unchanged('GOCSPX-short'));

// D4 Stripe webhook signing secret
ok('D4 whsec_ masked', masked('whsec_abcdefghij1234567890ABCDEFGHIJ'));
ok('D4 near-miss short whsec_ unchanged', unchanged('whsec_tiny'));

// D5 DigitalOcean token + GitLab PAT
ok('D5 dop_v1_ masked', masked('dop_v1_' + 'a1b2c3d4'.repeat(8)));
ok('D5 glpat- masked', masked('glpat-abcdef1234567890ABCDEF'));
ok('D5 near-miss short dop_v1_ unchanged', unchanged('dop_v1_deadbeef'));
ok('D5 near-miss short glpat- unchanged', unchanged('glpat-x'));

// D6 PKCS#8 ENCRYPTED PRIVATE KEY (added to the PEM prefix alternation)
ok('D6 ENCRYPTED PRIVATE KEY masked',
  masked('-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkq\nabcDEF012345+/==\n-----END ENCRYPTED PRIVATE KEY-----'));
ok('D6 near-miss prose "encrypted private key" unchanged', unchanged('this file holds an encrypted private key backup'));

// D7 opaque base64 Bearer token: the whole token masks (old class stopped at the first +/=// and leaked the tail)
{
  const opaque = 'Bearer YWJjZGVmZ2hp+jkl/mnopqrs123456=';
  const out = redactString(opaque).text;
  ok('D7 opaque base64 Bearer masked', out.includes('REDACTED'));
  ok('D7 opaque base64 Bearer leaks no tail', out === 'Bearer ' + '***REDACTED***');
  ok('D7 opaque base64 Bearer: no fragment of the token survives', !/jkl|mnopqrs|123456/.test(out));
  ok('D7 near-miss "Bearer of bad news" unchanged', unchanged('Bearer of bad news'));
}

// C8 redaction guards: basic-auth, conn-uri, bearer/jwt
ok('C8 basic-auth masks Authorization: Basic <b64>', masked('Authorization: Basic dXNlcjpwYXNzd29yZA=='));
ok('C8 basic-auth does NOT mask the prose "Basic authentication"', unchanged('Basic authentication is required for this endpoint'));
ok('C8 conn-uri-cred masks the password', masked('{"db":"mysql://admin:p4ssw0rdSecret@db.example.com:3306/app"}'));
ok('C8 conn-uri-cred keeps the line valid JSON (no corruption)', parses('{"db":"mysql://admin:p4ssw0rdSecret@db.example.com:3306/app"}'));
ok('C8 Bearer JWT masked', masked('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'));
ok('C8 bare JWT masked', masked('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij0123456789'));

// ReDoS safety: an adversarial long run of value-class chars must complete quickly (linear time, no backtracking)
{
  const t0 = Date.now();
  redactString('Bearer ' + 'a/+='.repeat(30000) + ' AccountKey=' + 'b'.repeat(120000) + ' sig=' + 'c'.repeat(120000));
  ok('ReDoS: 480k-char adversarial input redacts in < 1s', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
}

// ReDoS safety (#1 rule): the JSON escaped-value class (?:[^"\\]|\\.){4,} has disjoint-first-char alternatives
// ([^"\\] never starts with \, \\. always does), so a huge run of \" escapes (matching) or a trailing unclosed
// backslash with no closing quote (non-matching) both stay linear — no ambiguous backtracking.
{
  const t0 = Date.now();
  redactString('{"password":"' + 'a\\"'.repeat(60000) + 'tail"}');    // 180k-char matching run
  redactString('{"token":"' + 'x'.repeat(120000) + '\\');            // non-matching: unclosed trailing backslash
  ok('ReDoS: JSON escaped-value adversarial input redacts in < 1s', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
}

process.exit(summary());
