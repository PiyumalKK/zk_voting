package main

import (
	"context"
	"crypto/ecdsa"
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethdb"
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/chain"
	"zk-blockchain/internal/config"
	"zk-blockchain/internal/consensus"
	"zk-blockchain/internal/p2p"
	"zk-blockchain/internal/rpc"
)

// BFT wiring (CONSENSUS_MODE=bft). This is the third node shape, alongside
// the standalone and primary/replica shapes replication.go describes:
//
//	validator   co-equal writer. Serves the same P2P endpoints every node
//	            does, plus /p2p/consensus and /p2p/commitseals; runs the
//	            consensus engine; follows the cluster to catch up whatever it
//	            missed while it was down.
//
// Nothing here runs unless CONSENSUS_MODE is bft, and startReplication keeps
// its existing two branches untouched — which is what makes the flag a
// genuine revert path rather than a nominal one.
//
// The four validators are all ROLE=primary. There is no replica in a BFT
// cluster: a replica cannot propose, so a validator configured as one would
// hold a key, be counted in the quorum, and never take its turn — leaving the
// cluster permanently one validator short. config.validateBFT rejects it.

// startBFT builds and starts everything CONSENSUS_MODE=bft needs, returning
// the engine so cmd/node can route writes through it.
func (r *replication) startBFT(ctx context.Context, cfg *config.Config, seq *chain.Sequencer, db ethdb.Database) (*consensus.Engine, error) {
	self, key, err := loadValidatorIdentity(cfg)
	if err != nil {
		return nil, err
	}

	validators, err := consensus.NewValidatorSet(cfg.ValidatorSet, cfg.Quorum)
	if err != nil {
		return nil, fmt.Errorf("validator set: %w", err)
	}
	selfValidator, ok := validators.Lookup(self)
	if !ok {
		// config.Validate already checks this; repeating it here means the
		// engine can never be constructed with an identity nobody counts,
		// whatever a future caller does.
		return nil, fmt.Errorf("this node's key derives to %s, which is not in VALIDATOR_SET", self)
	}

	clientTLS, err := p2p.ClientTLSConfig(cfg.TLSCert, cfg.TLSKey, cfg.TLSCA)
	if err != nil {
		return nil, fmt.Errorf("p2p client TLS (run `make gen-certs`): %w", err)
	}

	peers := make([]*p2p.Client, 0, len(cfg.ConsensusPeers))
	for _, peer := range cfg.ConsensusPeers {
		client, err := p2p.NewClient(peer.P2PURL, clientTLS, 0)
		if err != nil {
			return nil, fmt.Errorf("consensus peer %q (%s): %w", peer.Name, peer.P2PURL, err)
		}
		peers = append(peers, client)
	}

	seals := consensus.NewStore(db)
	transport := p2p.NewConsensusTransport(p2p.ConsensusTransportConfig{Peers: peers})
	// Identity in a production build; see byzantine_off.go. The only build
	// that returns anything else is the `byzantine` one, which exists purely
	// so the equivocation demonstration in CONSENSUS.md can be run on real
	// machines.
	engineTransport := wrapTransport(transport, cfg.ValidatorID)

	// The follower is what makes a restarted validator able to rejoin: it
	// pulls the blocks it missed from whichever peer has them and applies
	// each through the ordinary verifying path. MultiPrimary exists because
	// under consensus there is no single primary to pull from.
	source, err := p2p.NewMultiPrimary(peers)
	if err != nil {
		return nil, err
	}
	follower, err := p2p.NewFollower(p2p.FollowerConfig{
		Chain:     seq,
		Applier:   seq,
		Primary:   source,
		SyncSeals: syncSealsFrom(source, seq, seals),
	})
	if err != nil {
		return nil, err
	}
	r.follower = follower

	engine, err := consensus.NewEngine(consensus.Config{
		ChainID:      cfg.ChainID,
		Self:         selfValidator,
		Key:          key,
		Validators:   validators,
		RoundTimeout: cfg.RoundTimeout(),
		Chain:        seq,
		Seals:        seals,
		Transport:    engineTransport,
		CatchUp:      follower.RequestCatchUp,
	})
	if err != nil {
		return nil, err
	}

	handler, err := p2p.NewHandler(p2p.HandlerConfig{
		Role:      config.RolePrimary,
		Chain:     seq,
		Applier:   follower,
		Consensus: engine,
		Seals:     seals,
	})
	if err != nil {
		return nil, err
	}
	if err := r.serveP2P(cfg, handler); err != nil {
		return nil, err
	}

	// Writes submitted here are forwarded to the current proposer when its
	// RPC URL is known and it is reachable, and handled locally otherwise.
	// Optional on purpose: with no VALIDATOR_RPC_URLS every node handles its
	// own submissions, which is still correct — just one round timeout slower
	// when the receiving node is not the proposer.
	if len(cfg.ValidatorRPCURLs) > 0 {
		r.forwarder = rpc.NewDynamicForwarder(proposerResolver(cfg, validators, engine, selfValidator), 0)
	}

	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		transport.Run(ctx)
	}()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		follower.Run(ctx)
	}()
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		engine.Run(ctx)
	}()

	log.Info().
		Str("validator", selfValidator.Name).
		Str("address", selfValidator.Address.Hex()).
		Int("validators", validators.Size()).
		Int("quorum", validators.Quorum()).
		Int("tolerates", validators.FaultTolerance()).
		Int("peers", len(peers)).
		Int("p2pPort", cfg.P2PPort).
		Dur("roundTimeout", cfg.RoundTimeout()).
		Bool("byzantineBuild", byzantineBuild).
		Msg("BFT consensus started: a block is final only once a quorum of validators has signed it")

	return engine, nil
}

// loadValidatorIdentity reads this node's signing key and derives its address.
func loadValidatorIdentity(cfg *config.Config) (common.Address, *ecdsa.PrivateKey, error) {
	hexKey, err := cfg.ConsensusPrivateKeyHex()
	if err != nil {
		return common.Address{}, nil, err
	}
	key, err := crypto.HexToECDSA(hexKey)
	if err != nil {
		return common.Address{}, nil, fmt.Errorf("consensus signing key: %w", err)
	}
	return crypto.PubkeyToAddress(key.PublicKey), key, nil
}

// proposerResolver answers "where should a write go right now": the current
// proposer's JSON-RPC URL, or false when this node is the proposer.
//
// It reads the engine's status snapshot, which is served from atomics and
// never blocks the state machine — a resolver that could block would put the
// consensus loop behind an HTTP request, which is the one thing it must never
// wait on.
func proposerResolver(cfg *config.Config, vs *consensus.ValidatorSet, engine *consensus.Engine, self consensus.Validator) func() (string, bool) {
	return func() (string, bool) {
		status := engine.Status()
		if status.Proposer == "" || status.Proposer == self.Name {
			return "", false // this node's turn; handle it here
		}
		url, ok := cfg.ValidatorRPCURLs[status.Proposer]
		if !ok || url == "" {
			return "", false // no address for the proposer; handle it here
		}
		return url, true
	}
}

// syncSealsFrom pulls the commit certificates for blocks the follower just
// applied and stores whichever verify locally.
//
// Certificates are best-effort by design. A block's validity comes from
// re-execution (replay.go), never from its seals, so a peer with a truncated
// seal store must not be able to stop this node from syncing — that would
// turn a cosmetic gap in the audit trail into an outage. A block whose
// certificate could not be fetched simply reports null from
// zk_getCommitSeals, which is honest.
func syncSealsFrom(source *p2p.MultiPrimary, seq *chain.Sequencer, store *consensus.Store) func(ctx context.Context, from, to uint64) error {
	return func(ctx context.Context, from, to uint64) error {
		resp, err := source.CommitSeals(ctx, from, to)
		if err != nil {
			return err
		}
		for _, entry := range resp.Seals {
			// Only accept a certificate for the block this node actually
			// holds at that height. Without this check a peer could hand over
			// seals for some other block and they would sit in the store
			// keyed by a hash nothing references — harmless, but it would
			// make the store a place where a peer can write.
			block, err := seq.BlockByNumber(entry.Number)
			if err != nil || block.Hash() != entry.BlockHash {
				continue
			}
			seals := make([][]byte, 0, len(entry.Seals))
			for _, seal := range entry.Seals {
				seals = append(seals, seal)
			}
			if len(seals) == 0 {
				continue
			}
			if err := store.Put(entry.Number, entry.BlockHash, &consensus.CommitSeals{
				Round: entry.Round, Seals: seals,
			}); err != nil {
				return err
			}
		}
		return nil
	}
}

// zkService builds the additive zk_ namespace for a validator.
func zkService(cfg *config.Config, seq *chain.Sequencer, db ethdb.Database, engine *consensus.Engine) (*rpc.ZkService, error) {
	validators, err := consensus.NewValidatorSet(cfg.ValidatorSet, cfg.Quorum)
	if err != nil {
		return nil, err
	}
	return rpc.NewZkService(seq, consensus.NewStore(db), validators, engine, cfg.ChainID), nil
}

// Compile-time checks that the concrete types really satisfy the interfaces
// this wiring depends on. They cost nothing and turn a subtle runtime nil
// into a build failure — worth it because three of these four are the seams
// that keep internal/consensus from importing internal/p2p or internal/rpc.
var (
	_ p2p.ConsensusReceiver       = (*consensus.Engine)(nil)
	_ rpc.ConsensusStatusProvider = (*consensus.Engine)(nil)
	_ rpc.Proposer                = (*consensus.Engine)(nil)
	_ consensus.ChainOps          = (*chain.Sequencer)(nil)
	_ p2p.SealReader              = (*consensus.Store)(nil)
)
