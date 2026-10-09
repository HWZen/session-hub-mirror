export async function uploaderMain(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ok = false;
  let status = 0;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const inputText = Buffer.concat(chunks).toString("utf8");
    const separator = inputText.indexOf("\n");
    if (separator < 0) throw new Error();
    const configValue: unknown = JSON.parse(inputText.slice(0, separator));
    if (typeof configValue !== "object" || configValue === null || Array.isArray(configValue)) throw new Error();
    const config = configValue as Record<string, unknown>;
    if (typeof config["baseUrl"] !== "string"
      || typeof config["token"] !== "string"
      || typeof config["timeoutMs"] !== "number"
      || !Number.isSafeInteger(config["timeoutMs"])
      || config["timeoutMs"] < 1) throw new Error();
    const payloadJson = inputText.slice(separator + 1);
    if (payloadJson.length === 0) throw new Error();

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), config["timeoutMs"]);
    const endpoint = new URL(config["baseUrl"].replace(/\/+$/, "") + "/v1/sessions").toString();
    const response = await fetch(endpoint, {
      redirect: "error",
      method: "PUT",
      headers: {
        authorization: "Bearer " + config["token"],
        "content-type": "application/json",
      },
      body: payloadJson,
      signal: controller.signal,
    });
    status = response.status;
    ok = status >= 200 && status < 300;
    if (response.body) {
      try { await response.body.cancel(); } catch {}
    }
  } catch {
    ok = false;
    status = 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { process.stdout.write(JSON.stringify({ ok, status }) + "\n"); } catch {}
  }
}
