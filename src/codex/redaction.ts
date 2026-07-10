const SECRET_PATTERNS = [
  /gh[opsu]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
];

export function redactText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[redacted-secret]"),
    value,
  );
}

export function redactJson(value: unknown): string {
  return redactText(JSON.stringify(value));
}
