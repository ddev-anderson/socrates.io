/**
 * Leitor de Server-Sent Events sobre fetch + ReadableStream.
 *
 * O buffer é cortado por fronteira de evento (\n\n), nunca por chunk,
 * porque um evento pode chegar partido em vários pedaços de rede.
 */
export async function readSSE(response, { onEvent } = {}) {
  if (!response.body) throw new Error("Resposta sem corpo para streaming");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = () => {
    let sep;
    while ((sep = findSeparator(buffer)) !== -1) {
      const block = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index + sep.length);
      const event = parseBlock(block);
      if (event) onEvent?.(event);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flush();
    }
    buffer += decoder.decode();
    flush();
    if (buffer.trim()) {
      const event = parseBlock(buffer);
      if (event) onEvent?.(event);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

/**
 * Versão async-iterável do mesmo parser, usada pelo streaming de áudio.
 */
export async function* iterateSSE(response) {
  if (!response.body) throw new Error("Resposta sem corpo para streaming");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = findSeparator(buffer)) !== -1) {
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const event = parseBlock(block);
        if (event) yield event;
      }
    }

    buffer += decoder.decode();

    let sep;
    while ((sep = findSeparator(buffer)) !== -1) {
      const block = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index + sep.length);
      const event = parseBlock(block);
      if (event) yield event;
    }

    if (buffer.trim()) {
      const event = parseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

function findSeparator(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function parseBlock(block) {
  let event = "message";
  const data = [];

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value.trim();
    else if (field === "data") data.push(value);
  }

  if (!data.length) return null;
  return { event, data: data.join("\n") };
}
