package p2p

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/core/types"

	"zk-blockchain/internal/consensus"
)

// DefaultClientTimeout bounds a single P2P request. It has to comfortably
// exceed the time a replica spends *verifying* a pushed block, since the
// response only comes after re-execution: a HonkVerifier deployment is
// roughly 4.7M gas, well under a second, so 30 s is slack rather than a
// tuning parameter.
const DefaultClientTimeout = 30 * time.Second

// RemoteError is a peer's refusal, decoded. It exists so callers can branch
// on *why* — pusher.go retries a 5xx and gives up on a 409, follower.go
// reads Expected out of a gap response — instead of matching on strings.
type RemoteError struct {
	// StatusCode is the HTTP status the peer returned.
	StatusCode int
	// Code is ErrorResponse.Code (CodeGap, CodeStateMismatch, …), or empty
	// if the peer sent a body this package does not understand.
	Code string
	// Message is the peer's explanation.
	Message string
	// Expected is set for CodeGap: the block the peer needs next.
	Expected uint64
}

func (e *RemoteError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("peer returned %d (%s): %s", e.StatusCode, e.Code, e.Message)
	}
	return fmt.Sprintf("peer returned %d: %s", e.StatusCode, e.Message)
}

// Retryable reports whether repeating the identical request could plausibly
// succeed. A 5xx is the peer failing at something (a database read, say) and
// may well work a moment later; every 4xx here is a considered refusal, and
// re-sending the same block to a replica that rejected its state root — or
// that needs an earlier block first — only wastes both nodes' time. A gap
// heals by pulling, which the replica does for itself.
func (e *RemoteError) Retryable() bool {
	return e.StatusCode >= 500
}

// Client talks to one peer's P2P endpoint.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient builds a client for baseURL (e.g. https://127.0.0.1:9546) using
// tlsCfg for mutual authentication. A nil tlsCfg leaves the transport
// unconfigured, which is only appropriate for tests against a plain-HTTP
// server — every real peer link is mTLS.
func NewClient(baseURL string, tlsCfg *tls.Config, timeout time.Duration) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return nil, fmt.Errorf("invalid peer URL %q: %w", baseURL, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid peer URL %q: must include scheme and host, e.g. https://host:9546", baseURL)
	}
	if timeout <= 0 {
		timeout = DefaultClientTimeout
	}

	transport := &http.Transport{
		TLSClientConfig: tlsCfg,
		// The cluster is a handful of long-lived peers, so connections are
		// worth keeping: a push happens once per sealed block and would
		// otherwise pay a full TLS handshake every time.
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     90 * time.Second,
	}
	return &Client{
		baseURL: strings.TrimRight(parsed.String(), "/"),
		http:    &http.Client{Transport: transport, Timeout: timeout},
	}, nil
}

// NewClientWithHTTP wraps an existing http.Client. Used by tests, and by any
// caller that needs to share a transport.
func NewClientWithHTTP(baseURL string, hc *http.Client) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: hc}
}

// BaseURL reports the peer this client talks to — used in log lines, where
// "which replica" is the first thing anyone wants to know.
func (c *Client) BaseURL() string { return c.baseURL }

// Head fetches the peer's current head.
func (c *Client) Head(ctx context.Context) (HeadResponse, error) {
	var out HeadResponse
	err := c.do(ctx, http.MethodGet, PathHead, nil, &out)
	return out, err
}

// Blocks pulls up to limit blocks starting at from. The peer may return
// fewer (it caps the limit, and it stops at its own head), so a caller
// catching up loops until the returned Head is reached.
func (c *Client) Blocks(ctx context.Context, from uint64, limit int) (BlocksResponse, error) {
	if limit <= 0 {
		limit = DefaultPullLimit
	}
	path := PathBlocks + "?from=" + strconv.FormatUint(from, 10) + "&limit=" + strconv.Itoa(limit)

	var out BlocksResponse
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// PushBlock sends one sealed block to the peer and reports what it did with
// it. A duplicate comes back as StatusDuplicate rather than an error.
func (c *Client) PushBlock(ctx context.Context, block *types.Block) (PushResponse, error) {
	msg, err := EncodeBlock(block)
	if err != nil {
		return PushResponse{}, err
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return PushResponse{}, fmt.Errorf("marshal block %d: %w", block.NumberU64(), err)
	}

	var out PushResponse
	err = c.do(ctx, http.MethodPost, PathBlock, body, &out)
	return out, err
}

// SendConsensus delivers one signed BFT message to the peer.
//
// It reports only whether the message left this node, because that is all the
// caller can act on: the peer answers 202 the moment it has queued the
// message, and what its state machine then does is not observable from here
// and is not this node's business.
func (c *Client) SendConsensus(ctx context.Context, msg *consensus.SignedMessage) error {
	body, err := json.Marshal(msg.Wire())
	if err != nil {
		return fmt.Errorf("marshal %s for height %d: %w", msg.Type, msg.Height, err)
	}
	return c.do(ctx, http.MethodPost, PathConsensus, body, nil)
}

// CommitSeals pulls the commit certificates for blocks in [from, to].
func (c *Client) CommitSeals(ctx context.Context, from, to uint64) (SealsResponse, error) {
	path := PathCommitSeals + "?from=" + strconv.FormatUint(from, 10) + "&to=" + strconv.FormatUint(to, 10)

	var out SealsResponse
	err := c.do(ctx, http.MethodGet, path, nil, &out)
	return out, err
}

// do performs one request and decodes either the success body or the peer's
// ErrorResponse into a *RemoteError.
func (c *Client) do(ctx context.Context, method, path string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build %s %s: %w", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Bounded even on the error path: an unbounded ReadAll here would let a
	// peer decide how much memory this node allocates.
	payload, err := io.ReadAll(io.LimitReader(resp.Body, maxPushBodyBytes))
	if err != nil {
		return fmt.Errorf("%s %s: reading response: %w", method, path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		remote := &RemoteError{StatusCode: resp.StatusCode, Message: strings.TrimSpace(string(payload))}
		var decoded ErrorResponse
		if json.Unmarshal(payload, &decoded) == nil && decoded.Code != "" {
			remote.Code = decoded.Code
			remote.Message = decoded.Message
			remote.Expected = decoded.Expected
		}
		return remote
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return fmt.Errorf("%s %s: decoding response: %w", method, path, err)
	}
	return nil
}
