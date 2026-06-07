package main

import "github.com/vmihailenco/msgpack/v5"

// decodeMsgpack unwraps the manifest [config] table the host passes to
// pulp_init. Same helper every pulp-cell service uses.
func decodeMsgpack(data []byte, v any) error {
	return msgpack.Unmarshal(data, v)
}
