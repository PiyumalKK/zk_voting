# zk_voting REST API Specification

This document defines the REST API for the custom Go blockchain node. The API serves as the bridge between the Next.js frontend and the embedded EVM state.

## Base URL
`http://localhost:3001` (Default port; configurable in node)

## Authentication
- **Public Endpoints**: No authentication required.
- **Admin Endpoints**: Requires `X-Admin-Key` header.

---

## 1. Public Endpoints

### 1.1 Get Voting Data
Returns the current election statistics and Merkle tree state.

- **URL**: `/api/voting-data`
- **Method**: `GET`
- **Success Response**:
    - **Code**: 200 OK
    - **Content**:
      ```json
      {
        "question": "Should we implement ZK voting?",
        "owner": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "yes_votes": 12,
        "no_votes": 4,
        "tree_size": 16,
        "tree_depth": 16,
        "tree_root": "0x123...abc"
      }
      ```

### 1.2 Get Merkle Tree Leaves
Returns all registered commitments in order. Used by the frontend to reconstruct the Merkle tree for proof generation.

- **URL**: `/api/leaves`
- **Method**: `GET`
- **Success Response**:
    - **Code**: 200 OK
    - **Content**:
      ```json
      {
        "leaves": [
          "0x commitment1...",
          "0x commitment2...",
          "0x commitment3..."
        ]
      }
      ```

### 1.3 Get Circuit Artifacts
Serves the compiled Noir circuit (`circuits.json`) required for in-browser proof generation.

- **URL**: `/api/circuit`
- **Method**: `GET`
- **Success Response**:
    - **Code**: 200 OK
    - **Content**: `(JSON object from circuits.json)`

---

## 2. Voter Endpoints

### 2.1 Get Voter Status
Checks if an address is eligible to vote and if they have already registered.

- **URL**: `/api/voter/:address`
- **Method**: `GET`
- **URL Params**: `address` (Hex-encoded address)
- **Success Response**:
    - **Code**: 200 OK
    - **Content**:
      ```json
      {
        "is_allowed": true,
        "has_registered": false
      }
      ```

### 2.2 Register Commitment
Registers a voter's anonymous commitment to the Merkle tree.

- **URL**: `/api/register`
- **Method**: `POST`
- **Body**:
  ```json
  {
    "address": "0xUserAddress...",
    "commitment": "0xPoseidonCommitment..."
  }
  ```
- **Success Response**:
    - **Code**: 201 Created
    - **Content**:
      ```json
      {
        "tx_hash": "0x...",
        "leaf_index": 5
      }
      ```
- **Error Response**:
    - **Code**: 400 Bad Request (Not allowed, already registered, or invalid commitment)

### 2.3 Submit Vote
Submits a ZK proof to cast an anonymous vote.

- **URL**: `/api/vote`
- **Method**: `POST`
- **Body**:
  ```json
  {
    "proof": "0xZKProofBytes...",
    "nullifier_hash": "0x...",
    "root": "0xRootUsedInProof...",
    "vote": true,
    "depth": 16
  }
  ```
- **Success Response**:
    - **Code**: 200 OK
    - **Content**:
      ```json
      {
        "tx_hash": "0x...",
        "message": "Vote cast successfully"
      }
      ```
- **Error Response**:
    - **Code**: 400 Bad Request (Invalid proof, double vote, or incorrect root)

---

## 3. Administrative Endpoints

### 3.1 Add Voters
Adds multiple addresses to the voting allowlist.

- **URL**: `/api/admin/voters`
- **Method**: `POST`
- **Headers**: `X-Admin-Key: <secret_key>`
- **Body**:
  ```json
  {
    "voters": [
      "0xaddr1...",
      "0xaddr2..."
    ],
    "statuses": [true, true]
  }
  ```
- **Success Response**:
    - **Code**: 200 OK
    - **Content**: `{ "tx_hash": "0x..." }`

---

## 4. Block Explorer Endpoints

### 4.1 List Blocks
Returns a paginated list of blocks in the chain.

- **URL**: `/api/blocks?page=1&limit=10`
- **Method**: `GET`
- **Success Response**:
    - **Code**: 200 OK
    - **Content**:
      ```json
      {
        "blocks": [
          {
            "index": 10,
            "hash": "0x...",
            "prev_hash": "0x...",
            "timestamp": 1623750000,
            "tx_count": 1
          }
        ]
      }
      ```

### 4.2 Get Block Details
Returns full transaction details for a specific block.

- **URL**: `/api/blocks/:index`
- **Method**: `GET`
- **Success Response**:
    - **Code**: 200 OK
    - **Content**: `(Full Block Object)`

---

## 5. Error Handling
All error responses follow this standard format:
```json
{
  "error": "Error message description",
  "code": "ERROR_CODE_STRING"
}
```
Common codes: `INVALID_PROOF`, `ALREADY_VOTED`, `UNAUTHORIZED`, `NOT_ALLOWED`.
