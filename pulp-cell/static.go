package main

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"

	pulpgin "github.com/BananaLabs-OSS/Fiber/pulp/gin"
)

// public is the static frontend, embedded into the wasm so the cell is
// self-contained and single-origin. The build copies the repo's ../public
// into pulp-cell/public before `go build` (see README).
//
//go:embed all:public
var publicFS embed.FS

func readPublic(rel string) ([]byte, bool) {
	data, err := fs.ReadFile(publicFS, "public/"+rel)
	if err != nil {
		return nil, false
	}
	return data, true
}

func serveIndex(c *pulpgin.Context) {
	data, ok := readPublic("index.html")
	if !ok {
		c.String(http.StatusNotFound, "not found")
		return
	}
	c.Data(http.StatusOK, "text/html; charset=utf-8", data)
}

// serveFileHandler serves one fixed embedded file with a fixed content type.
func serveFileHandler(rel, contentType string) pulpgin.HandlerFunc {
	return func(c *pulpgin.Context) {
		data, ok := readPublic(rel)
		if !ok {
			c.String(http.StatusNotFound, "not found")
			return
		}
		c.Data(http.StatusOK, contentType, data)
	}
}

// serveDirHandler serves a single :file out of an embedded subdirectory,
// guarding against path traversal.
func serveDirHandler(dir string) pulpgin.HandlerFunc {
	return func(c *pulpgin.Context) {
		name := c.Param("file")
		if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
			c.String(http.StatusBadRequest, "bad path")
			return
		}
		data, ok := readPublic(dir + "/" + name)
		if !ok {
			c.String(http.StatusNotFound, "not found")
			return
		}
		c.Data(http.StatusOK, contentTypeFor(name), data)
	}
}

func contentTypeFor(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".ico"):
		return "image/x-icon"
	case strings.HasSuffix(name, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".jpg"), strings.HasSuffix(name, ".jpeg"):
		return "image/jpeg"
	default:
		return "application/octet-stream"
	}
}
