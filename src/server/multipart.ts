/** Minimal multipart/form-data parser (OpenAI audio uploads). No dependencies, whole body in memory. */
export interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function boundaryOf(contentType: string): string | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  return (m?.[1] ?? m?.[2])?.trim();
}

export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    let start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === "--") break; // closing delimiter
    if (body.subarray(start, start + 2).toString() === "\r\n") start += 2;
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    const chunk = body.subarray(start, next - 2); // strip the CRLF before the next delimiter
    const headEnd = chunk.indexOf("\r\n\r\n");
    if (headEnd >= 0) {
      const head = chunk.subarray(0, headEnd).toString("utf8");
      const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? "";
      const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
      if (name !== undefined) {
        parts.push({
          name,
          filename: /\bfilename="([^"]*)"/i.exec(disp)?.[1],
          contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim(),
          data: Buffer.from(chunk.subarray(headEnd + 4)),
        });
      }
    }
    pos = next;
  }
  return parts;
}
