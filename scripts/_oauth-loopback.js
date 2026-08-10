// Shared helper: runs the modern OAuth "loopback" flow (Google deprecated the old
// copy-paste "oob" flow). Starts a temporary local server, opens/prints the consent
// URL, and automatically captures the authorization code when Google redirects back
// — no manual copy-pasting needed.
const http = require("http");
const { google } = require("googleapis");

function getRefreshToken({ clientId, clientSecret, scope, signInHint }) {
  return new Promise((resolve, reject) => {
    let client, redirectUri;

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname !== "/oauth2callback") { res.writeHead(404); res.end(); return; }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(error
          ? `<h2>Access denied: ${error}. You can close this tab.</h2>`
          : "<h2>Success! You can close this tab and go back to the terminal.</h2>");
        server.close();

        if (error) { reject(new Error(error)); return; }
        const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
        resolve(tokens);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.listen(53682, "127.0.0.1", () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
      client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authUrl = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [scope] });

      console.log(`\n1. Open this URL in a browser, signed in as ${signInHint}:\n`);
      console.log(authUrl);
      console.log("\n2. Approve access — you'll be redirected back automatically, no code to paste.\n");
      console.log("Waiting for you to approve in the browser...");
    });
  });
}

module.exports = { getRefreshToken };
