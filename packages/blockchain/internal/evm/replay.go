package evm

import (
	"github.com/rs/zerolog/log"

	"zk-blockchain/internal/core"
)

// ReplayBlockchain iterates every block in the chain (skipping genesis) and
// calls the appropriate EVM function for each transaction. This reconstructs
// the EVM state from the blockchain, making the two stores consistent.
//
// Errors during replay are logged as warnings but do not abort the process —
// a block that was committed without EVM verification (Stage 1/2 data) may
// not pass the ZK verifier, and that is acceptable during state reconstruction.
func ReplayBlockchain(bc *core.Blockchain, bridge *ContractBridge) {
	blocks := bc.GetBlocks()
	var replayed, failed int

	for _, block := range blocks {
		if block.IsGenesis() {
			continue
		}
		for _, tx := range block.Transactions {
			if err := bridge.ReplayTransaction(tx); err != nil {
				log.Warn().
					Str("tx_id", tx.ID).
					Str("tx_type", string(tx.Type)).
					Uint64("block", block.Index).
					Err(err).
					Msg("EVM replay skipped for transaction")
				failed++
			} else {
				replayed++
			}
		}
	}

	log.Info().
		Int("replayed", replayed).
		Int("skipped", failed).
		Msg("EVM state replay complete")
}

// ReplayTransaction applies a single blockchain transaction to the EVM.
// It dispatches to the correct bridge method based on transaction type.
func (b *ContractBridge) ReplayTransaction(tx core.Transaction) error {
	switch tx.Type {
	case core.TxAddVoter:
		var p core.AddVoterPayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		return b.AddVoter(p.VoterID, p.Allowed)

	case core.TxRegister:
		var p core.RegisterPayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		_, err := b.Register(p.VoterID, p.Commitment)
		return err

	case core.TxVote:
		var p core.VotePayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		return b.Vote(p.Proof, p.NullifierHash, p.Root, p.CandidateIndex, p.Depth)

	case core.TxSetQuestion:
		var p core.SetQuestionPayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		return b.SetQuestion(p.Question)

	case core.TxSetCandidates:
		var p core.SetCandidatesPayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		return b.SetCandidates(p.Candidates)

	case core.TxStartRegistration:
		var p core.StartRegistrationPayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		return b.StartRegistration(p.DurationSec)

	case core.TxStartVoting:
		var p core.StartVotingPayload
		if err := tx.ParsePayload(&p); err != nil {
			return err
		}
		return b.StartVoting(p.DurationSec)

	case core.TxEndElection:
		return b.EndElection()

	case core.TxResetElection:
		return b.ResetElection()

	default:
		// Genesis and any future transaction types are silently skipped.
		return nil
	}
}
