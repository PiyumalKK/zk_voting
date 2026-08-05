package rpc

import (
	"fmt"
	"testing"
)

func TestDecodeRevertReason(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want string
	}{
		{"empty data", nil, ""},
		{"too short", []byte{0x08, 0xc3, 0x79, 0xa0, 0x01}, ""},
		{"wrong selector", append([]byte{0xde, 0xad, 0xbe, 0xef}, encodeErrorString("boom")[4:]...), ""},
		{"valid empty reason", encodeErrorString(""), ""},
		{"valid short reason", encodeErrorString("boom"), "boom"},
		{"valid reason exactly 32 bytes", encodeErrorString("exactly-thirty-two-bytes-long!!!"), "exactly-thirty-two-bytes-long!!!"},
		{"valid reason spanning multiple words", encodeErrorString("this reason string is longer than thirty two bytes"), "this reason string is longer than thirty two bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decodeRevertReason(tt.data); got != tt.want {
				t.Errorf("decodeRevertReason(%x) = %q, want %q", tt.data, got, tt.want)
			}
		})
	}
}

func TestNewRevertErrorShape(t *testing.T) {
	withReason := newRevertError(encodeErrorString("nope"))
	if withReason.Error() != "execution reverted: nope" {
		t.Errorf("Error() = %q, want %q", withReason.Error(), "execution reverted: nope")
	}
	if withReason.ErrorCode() != 3 {
		t.Errorf("ErrorCode() = %d, want 3", withReason.ErrorCode())
	}
	wantData := fmt.Sprintf("0x%x", encodeErrorString("nope"))
	if got := withReason.ErrorData(); got != wantData {
		t.Errorf("ErrorData() = %v, want %s", got, wantData)
	}

	custom := newRevertError([]byte{0xde, 0xad, 0xbe, 0xef})
	if custom.Error() != "execution reverted" {
		t.Errorf("Error() = %q, want %q", custom.Error(), "execution reverted")
	}
	if custom.ErrorData() != "0xdeadbeef" {
		t.Errorf("ErrorData() = %v, want 0xdeadbeef", custom.ErrorData())
	}

	empty := newRevertError(nil)
	if empty.Error() != "execution reverted" {
		t.Errorf("Error() with no data = %q, want %q", empty.Error(), "execution reverted")
	}
}
