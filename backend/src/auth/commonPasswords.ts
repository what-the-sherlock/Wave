/**
 * A small blocklist of the most common leaked passwords — not the full
 * top-10k list `security-model.md` §3 mentions, and not zxcvbn (a ~800KB
 * dependency for a check this narrow). This catches the passwords someone
 * would actually type first ("password", "qwerty123", ...), which is most
 * of the realistic risk, at zero dependency cost. Revisit if a real attack
 * pattern shows this isn't enough.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set(
  [
    "password",
    "password1",
    "password123",
    "12345678",
    "123456789",
    "1234567890",
    "qwerty123",
    "qwertyuiop",
    "letmein123",
    "welcome123",
    "admin1234",
    "iloveyou1",
    "abc123456",
    "123123123",
    "sunshine1",
    "princess1",
    "football1",
    "baseball1",
    "dragon123",
    "monkey123",
    "shadow123",
    "master123",
    "superman1",
    "trustno1a",
    "letmein12",
    "changeme1",
    "passw0rd1",
    "p@ssw0rd1",
    "password!",
    "P@ssw0rd1",
    "11111111",
    "00000000",
    "87654321",
    "12341234",
    "1q2w3e4r5",
    "qazwsxedc",
    "zaq12wsx1",
    "asdfghjkl",
    "asdf1234",
    "starwars1",
    "whatever1",
    "freedom12",
    "michael12",
    "jennifer1",
    "computer1",
    "internet1",
    "hunter123",
    "batman123",
    "matrix123",
    "cheese123",
  ].map((p) => p.toLowerCase()),
);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}
