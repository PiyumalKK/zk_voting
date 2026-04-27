use std::hash::poseidon::bn254::hash_1;
use std::hash::poseidon::bn254::hash_2;

fn main(
    // public inputs
    nullifier_hash: pub Field,
    // private inputs
    nullifier: Field,
    secret: Field,
) {
    // Recompute nullifier_hash and verify it matches the public input
    let computed_nullifier_hash: Field = hash_1([nullifier]);
    assert(computed_nullifier_hash == nullifier_hash);

    // Compute the commitment (leaf of the Merkle tree)
    // This will be used in the next phase for root verification
    let _commitment: Field = hash_2([nullifier, secret]);
}
