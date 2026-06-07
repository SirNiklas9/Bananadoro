// Bananadoro deployment binary — a custom Pulp host built with exactly the
// extensions this app needs. The blank imports run each extension's init()
// to register its capabilities; run.Main loads the cell manifests passed
// via -manifest and serves them.
//
// Run the timer cell alone:
//
//	go build -o bananadoro-host .
//	HTTP_PORT=3000 JWT_SECRET=dev-secret \
//	  ./bananadoro-host -manifest ../pulp-cell/pulp.cell.toml
//
// Run it alongside the bananauth cell in ONE host (shared sqlite + the
// same JWT secret — this is the recommended production layout):
//
//	HTTP_PORT=3000 JWT_SECRET=dev-secret \
//	  ./bananadoro-host -manifest ../pulp-cell/pulp.cell.toml,../../Bananauth/pulp-cell/pulp.cell.toml
//
// ext-sqlite backs storage.sqlite; ext-http backs bananauth's outbound
// OAuth/Resend calls. Inbound HTTP, SSE and entropy.read are Pulp core.
package main

import (
	_ "github.com/BananaLabs-OSS/Pulp-ext-entropy"
	_ "github.com/BananaLabs-OSS/Pulp-ext-http"
	_ "github.com/BananaLabs-OSS/Pulp-ext-sqlite"

	"github.com/BananaLabs-OSS/Pulp/run"
)

func main() { run.Main() }
