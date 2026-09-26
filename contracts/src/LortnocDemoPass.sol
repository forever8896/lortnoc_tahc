// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LortnocDemoPass — an open-mint ERC-721 for demoing token-gated spaces (§23)
/// @notice Anyone can mint: `mint()` gives one pass to the caller, `mintTo(to)` gives one to `to`.
///         It gates nothing of value; it exists so a demo space can carry
///         `eth.lortnoc.space.token = eip155:11155111/erc721:<this>` and a reader can hold one.
///         TESTNET ONLY — an open mint on mainnet would be a gate anyone walks through.
/// @dev Minimal, dependency-free ERC-721 (+ Metadata). No enumeration.
contract LortnocDemoPass {
    string public constant name = "Lortnoc Demo Pass";
    string public constant symbol = "LDP";

    uint256 public totalSupply;

    mapping(uint256 tokenId => address) internal _owners;
    mapping(address owner => uint256) internal _balances;
    mapping(uint256 tokenId => address) internal _approvals;
    mapping(address owner => mapping(address operator => bool)) internal _operators;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error ZeroAddress();
    error NonexistentToken(uint256 tokenId);
    error NotAuthorized();
    error WrongFrom();
    error UnsafeRecipient();

    // ---- minting -----------------------------------------------------------------------------

    function mint() external returns (uint256) {
        return _mint(msg.sender);
    }

    function mintTo(address to) external returns (uint256) {
        return _mint(to);
    }

    function _mint(address to) internal returns (uint256 id) {
        if (to == address(0)) revert ZeroAddress();
        id = ++totalSupply;
        _owners[id] = to;
        unchecked {
            _balances[to]++;
        }
        emit Transfer(address(0), to, id);
    }

    // ---- ERC-721 -----------------------------------------------------------------------------

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address o) {
        o = _owners[tokenId];
        if (o == address(0)) revert NonexistentToken(tokenId);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return "data:application/json,{\"name\":\"Lortnoc Demo Pass\",\"description\":\"Testnet pass for token-gated lortnoc spaces.\"}";
    }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        if (msg.sender != o && !_operators[o][msg.sender]) revert NotAuthorized();
        _approvals[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _approvals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _operators[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address o = ownerOf(tokenId);
        if (o != from) revert WrongFrom();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != o && !_operators[o][msg.sender] && _approvals[tokenId] != msg.sender) {
            revert NotAuthorized();
        }
        delete _approvals[tokenId];
        unchecked {
            _balances[from]--;
            _balances[to]++;
        }
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length != 0) {
            try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 r) {
                if (r != IERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
            } catch {
                revert UnsafeRecipient();
            }
        }
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 // ERC-165
            || id == 0x80ac58cd // ERC-721
            || id == 0x5b5e139f; // ERC-721 Metadata
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}
