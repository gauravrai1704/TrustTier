// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITier2Verifier
/// @notice Interface for the Tier-2 zero-knowledge proof verifier.
/// @dev Deliberately shaped to match the verifier contract EZKL generates
///      (proof bytes + public inputs -> bool), so the MockTier2Verifier used
///      during Weeks 1-2 can be swapped for the real EZKL-generated verifier
///      in the Weeks 3-5 phase without touching LiquidationEngine.
///
///      NOT declared `view`, deliberately: EZKL's generated Halo2Verifier
///      contract declares verifyProof as plain `public` (no view/pure
///      modifier), not `view`. Solidity resolves a call's opcode (CALL vs
///      STATICCALL) based on the *interface's* declared mutability at the
///      call site, not the callee's actual implementation - so if this
///      interface declared `view`, calling into the real EZKL verifier would
///      compile to a STATICCALL, which reverts if the callee performs any
///      state-touching operation (even one Solidity's own mutability
///      checker didn't catch, since inline-assembly-heavy generated code
///      like this bypasses most of solc's usual static analysis). Matching
///      EZKL's actual declared mutability exactly avoids that risk entirely.
interface ITier2Verifier {
    /// @param proof The zk-SNARK proof bytes.
    /// @param publicInputs The public inputs the proof is verified against
    ///        (e.g. a commitment to the model hash and the reported risk score).
    /// @return valid True if the proof verifies correctly.
    function verifyProof(bytes calldata proof, uint256[] calldata publicInputs)
        external
        returns (bool valid);
}
