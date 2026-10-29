// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TrustTierMultisig
/// @notice A minimal M-of-N multisig wallet. Any owner can submit a
///         transaction; it executes only after `threshold` distinct owners
///         have confirmed it. In TrustTier it is the sole proposer and
///         executor of the TrustTierTimelock, so changing what the system
///         trusts needs M signatures AND a public delay.
/// @dev Deliberately small and dependency-free so it can be read in full. A
///      production deployment would use an audited wallet such as Safe; the
///      timelock accepts any proposer address, so swapping this for a Safe
///      needs no contract changes.
contract TrustTierMultisig {
    struct Transaction {
        address target;
        uint256 value;
        bytes data;
        bool executed;
        uint256 confirmations;
    }

    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    Transaction[] public transactions;
    /// @notice txId => owner => has confirmed
    mapping(uint256 => mapping(address => bool)) public confirmed;

    event Submitted(uint256 indexed txId, address indexed owner, address indexed target, uint256 value, bytes data);
    event Confirmed(uint256 indexed txId, address indexed owner);
    event Revoked(uint256 indexed txId, address indexed owner);
    event Executed(uint256 indexed txId, address indexed executor);
    event Deposit(address indexed from, uint256 amount);

    error NotOwner(address caller);
    error InvalidOwners();
    error InvalidThreshold(uint256 threshold, uint256 owners);
    error TxDoesNotExist(uint256 txId);
    error TxAlreadyExecuted(uint256 txId);
    error AlreadyConfirmed(uint256 txId, address owner);
    error NotConfirmed(uint256 txId, address owner);
    error NotEnoughConfirmations(uint256 txId, uint256 have, uint256 need);
    error ExecutionFailed(uint256 txId, bytes returnData);

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
        _;
    }

    modifier txExists(uint256 txId) {
        if (txId >= transactions.length) revert TxDoesNotExist(txId);
        _;
    }

    modifier notExecuted(uint256 txId) {
        if (transactions[txId].executed) revert TxAlreadyExecuted(txId);
        _;
    }

    constructor(address[] memory _owners, uint256 _threshold) {
        if (_owners.length == 0) revert InvalidOwners();
        if (_threshold == 0 || _threshold > _owners.length) revert InvalidThreshold(_threshold, _owners.length);
        for (uint256 i = 0; i < _owners.length; i++) {
            address o = _owners[i];
            if (o == address(0) || isOwner[o]) revert InvalidOwners();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = _threshold;
    }

    receive() external payable {
        emit Deposit(msg.sender, msg.value);
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function transactionCount() external view returns (uint256) {
        return transactions.length;
    }

    /// @notice Propose a call; the submitter's confirmation is counted.
    function submit(address target, uint256 value, bytes calldata data) external onlyOwner returns (uint256 txId) {
        txId = transactions.length;
        transactions.push(Transaction({target: target, value: value, data: data, executed: false, confirmations: 0}));
        emit Submitted(txId, msg.sender, target, value, data);
        _confirm(txId);
    }

    function confirm(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        _confirm(txId);
    }

    function revoke(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        if (!confirmed[txId][msg.sender]) revert NotConfirmed(txId, msg.sender);
        confirmed[txId][msg.sender] = false;
        transactions[txId].confirmations -= 1;
        emit Revoked(txId, msg.sender);
    }

    /// @notice Execute once `threshold` owners have confirmed. Effects
    ///         (executed = true) happen before the external call.
    function execute(uint256 txId) external onlyOwner txExists(txId) notExecuted(txId) {
        Transaction storage t = transactions[txId];
        if (t.confirmations < threshold) revert NotEnoughConfirmations(txId, t.confirmations, threshold);
        t.executed = true;
        (bool ok, bytes memory ret) = t.target.call{value: t.value}(t.data);
        if (!ok) revert ExecutionFailed(txId, ret);
        emit Executed(txId, msg.sender);
    }

    function _confirm(uint256 txId) internal {
        if (confirmed[txId][msg.sender]) revert AlreadyConfirmed(txId, msg.sender);
        confirmed[txId][msg.sender] = true;
        transactions[txId].confirmations += 1;
        emit Confirmed(txId, msg.sender);
    }
}
