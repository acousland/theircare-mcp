# Security

Supported version: latest code on main. This early release handles a local session and private family bookings.

Never post credentials, cookies, CRNs, family records, .runtime files or authenticated HTML publicly.

Report vulnerabilities through **Security → Report a vulnerability** if available. Otherwise open a minimal issue asking for a private channel, without exploit details or personal information.

This is a single-user application, not a multi-user service. Optional remote mode puts it on the internet behind single-account Google sign-in and OAuth; treat data/oauth.json and .env like .runtime. Browser confirmation is not isolation from malicious local software. THEIRCARE_ALLOW_AI_SAVE=true deliberately removes that boundary: your AI client can then save bookings and accept terms after you agree in chat. MCP results go to your AI client. See the README for data handling and validation limits.
