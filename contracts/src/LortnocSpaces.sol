// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LortnocSpaces — buy a founding community space, paid on Ethereum mainnet
/// @notice A space is a named place with its own reader rules (docs/PRD-universal.md §22). Buying
///         one here is the durable proof of purchase: the relayer reads `SpaceBought`, then creates
///         the space as an ENS v2 name on Sepolia with its rules records — and re-creates it from
///         these events after every Sepolia reset, until ENS v2 reaches mainnet.
///
///         Deliberately small. No Semaphore: the paying wallet IS publicly linked to the space, which
///         is acceptable for token communities whose creators are public anyway (§22.7). The free,
///         anonymous public-good tier needs no payment at all.
///
/// @dev The contract never holds a balance: the price goes to the treasury and any excess back to
///      the payer in the same call. Label rules mirror the relayer's handle rule exactly, so a
///      purchase can never succeed here for a name the relayer would refuse to create.
contract LortnocSpaces {
    address public owner;
    address public treasury;
    uint256 public price;
    uint256 public spaceCount;
    /// @notice Early-bird: the first `earlyCount` spaces cost `earlyPrice` (e.g. 10% of `price`).
    uint256 public earlyPrice;
    uint256 public earlyCount;

    /// @dev keccak256(label) → taken. First purchase wins; a label is never sold twice.
    mapping(bytes32 labelHash => bool) public taken;

    event SpaceBought(
        uint256 indexed id, string label, address indexed spaceOwner, bytes32 rulesHash, address indexed payer, uint256 price
    );
    event PriceChanged(uint256 price);
    event EarlyBirdChanged(uint256 earlyPrice, uint256 earlyCount);
    event TreasuryChanged(address treasury);
    event OwnershipTransferred(address owner);

    error NotOwner();
    error ZeroAddress();
    error InvalidLabel();
    error LabelTaken(string label);
    error Underpaid(uint256 sent, uint256 price);
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param owner_ controls price and treasury — pass a COLD wallet, not the deploy key.
    constructor(uint256 price_, uint256 earlyPrice_, uint256 earlyCount_, address treasury_, address owner_) {
        if (treasury_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        price = price_;
        earlyPrice = earlyPrice_;
        earlyCount = earlyCount_;
        treasury = treasury_;
        owner = owner_;
    }

    /// @notice Buy the space `label`.
    /// @param label      3–32 of [a-z0-9-], not starting or ending with '-'
    /// @param spaceOwner who will own the space name (may differ from the payer)
    /// @param rulesHash  keccak256 of the space's initial rules; the relayer checks the rules it is
    ///                   given against this, so it cannot publish different ones
    function buySpace(string calldata label, address spaceOwner, bytes32 rulesHash) external payable returns (uint256 id) {
        if (spaceOwner == address(0)) revert ZeroAddress();
        if (!validLabel(label)) revert InvalidLabel();
        bytes32 h = keccak256(bytes(label));
        if (taken[h]) revert LabelTaken(label);
        uint256 p = currentPrice();
        if (msg.value < p) revert Underpaid(msg.value, p);

        taken[h] = true;
        id = ++spaceCount;
        emit SpaceBought(id, label, spaceOwner, rulesHash, msg.sender, p);

        (bool sent,) = treasury.call{value: p}("");
        if (!sent) revert TransferFailed();
        if (msg.value > p) {
            (bool refunded,) = msg.sender.call{value: msg.value - p}("");
            if (!refunded) revert TransferFailed();
        }
    }

    /// @notice What the NEXT space costs: the early-bird price while fewer than `earlyCount` are sold.
    function currentPrice() public view returns (uint256) {
        return spaceCount < earlyCount ? earlyPrice : price;
    }

    /// @notice How many early-bird spaces are left.
    function earlyLeft() external view returns (uint256) {
        return spaceCount < earlyCount ? earlyCount - spaceCount : 0;
    }

    function available(string calldata label) external view returns (bool) {
        return validLabel(label) && !taken[keccak256(bytes(label))];
    }

    /// @dev Same rule as relayer/server.mjs /claim: ^[a-z0-9-]{3,32}$, no leading/trailing '-'.
    function validLabel(string calldata label) public pure returns (bool) {
        bytes calldata b = bytes(label);
        if (b.length < 3 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceChanged(price_);
    }

    function setEarlyBird(uint256 earlyPrice_, uint256 earlyCount_) external onlyOwner {
        earlyPrice = earlyPrice_;
        earlyCount = earlyCount_;
        emit EarlyBirdChanged(earlyPrice_, earlyCount_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        owner = to;
        emit OwnershipTransferred(to);
    }
}
