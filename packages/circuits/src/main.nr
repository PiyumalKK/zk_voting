use std::hash::poseidon::bn254::hash_1;
use std::hash::poseidon::bn254::hash_2;
use binary_merkle_root::binary_merkle_root;

fn main(
    // public inputs
    nullifier_hash: pub Field,
    // private inputs
    nullifier: Field,
    secret: Field,
    // public inputs
    root: pub Field,
    vote: pub bool,
    depth: pub u32,
    // private inputs
    index: Field,
    // max of 2^16 leaves --> 65536 leaves
    siblings: [Field; 16],
) {
    // Recompute nullifier_hash and verify it matches the public input
    let computed_nullifier_hash: Field = hash_1([nullifier]);
    assert(computed_nullifier_hash == nullifier_hash);

    // Compute the commitment (leaf of the Merkle tree)
    let commitment: Field = hash_2([nullifier, secret]);

    // Count the non-zero siblings to determine the actual path length
    let mut siblings_num = 0;
    for i in 0..siblings.len() {
        if siblings[i] != 0 {
            siblings_num += 1;
        }
    }
    // Ensure depth doesn't exceed the fixed array length
    assert(depth <= siblings.len());

    // Convert leaf index to little-endian bits for path traversal
    let index_bits: [u1; 16] = index.to_le_bits();

    // Recompute the Merkle root from the commitment and siblings
    let computed_root = binary_merkle_root(hash_2, commitment, siblings_num, index_bits, siblings);

    // Assert the computed root matches the on-chain root
    assert(computed_root == root);

    // Bind the vote to the proof (prevents front-running with a different vote)
    let vote_field = vote as Field;
    assert((vote_field * vote_field) == vote_field);
}
