// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LortnocDemoPass, IERC721Receiver} from "../src/LortnocDemoPass.sol";

contract GoodReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract BadReceiver {}

contract LortnocDemoPassTest is Test {
    LortnocDemoPass internal pass;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal op = makeAddr("operator");

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function setUp() public {
        pass = new LortnocDemoPass();
    }

    function test_mint_toCaller_oneEach() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 1);
        vm.prank(alice);
        uint256 id = pass.mint();
        assertEq(id, 1);
        assertEq(pass.ownerOf(1), alice);
        assertEq(pass.balanceOf(alice), 1);
        vm.prank(alice);
        pass.mint();
        assertEq(pass.balanceOf(alice), 2);
        assertEq(pass.totalSupply(), 2);
    }

    function test_mintTo() public {
        vm.prank(alice);
        uint256 id = pass.mintTo(bob);
        assertEq(pass.ownerOf(id), bob);
        assertEq(pass.balanceOf(bob), 1);
        assertEq(pass.balanceOf(alice), 0);
        vm.expectRevert(LortnocDemoPass.ZeroAddress.selector);
        pass.mintTo(address(0));
    }

    function test_nonexistent() public {
        vm.expectRevert(abi.encodeWithSelector(LortnocDemoPass.NonexistentToken.selector, 7));
        pass.ownerOf(7);
        vm.expectRevert(LortnocDemoPass.ZeroAddress.selector);
        pass.balanceOf(address(0));
    }

    function test_transfer_byOwner_approved_operator() public {
        vm.prank(alice);
        uint256 id = pass.mint();

        vm.prank(bob);
        vm.expectRevert(LortnocDemoPass.NotAuthorized.selector);
        pass.transferFrom(alice, bob, id);

        vm.prank(alice);
        pass.approve(op, id);
        assertEq(pass.getApproved(id), op);
        vm.prank(op);
        pass.transferFrom(alice, bob, id);
        assertEq(pass.ownerOf(id), bob);
        assertEq(pass.getApproved(id), address(0), "approval cleared on transfer");
        assertEq(pass.balanceOf(alice), 0);
        assertEq(pass.balanceOf(bob), 1);

        vm.prank(bob);
        pass.setApprovalForAll(op, true);
        assertTrue(pass.isApprovedForAll(bob, op));
        vm.prank(op);
        pass.transferFrom(bob, alice, id);
        assertEq(pass.ownerOf(id), alice);

        vm.prank(alice);
        vm.expectRevert(LortnocDemoPass.WrongFrom.selector);
        pass.transferFrom(bob, alice, id);
    }

    function test_safeTransfer_receiverChecks() public {
        vm.prank(alice);
        uint256 id = pass.mint();
        GoodReceiver good = new GoodReceiver();
        BadReceiver bad = new BadReceiver();
        vm.prank(alice);
        vm.expectRevert(LortnocDemoPass.UnsafeRecipient.selector);
        pass.safeTransferFrom(alice, address(bad), id);
        vm.prank(alice);
        pass.safeTransferFrom(alice, address(good), id);
        assertEq(pass.ownerOf(id), address(good));
    }

    function test_supportsInterface_andMetadata() public {
        assertTrue(pass.supportsInterface(0x80ac58cd));
        assertTrue(pass.supportsInterface(0x5b5e139f));
        assertTrue(pass.supportsInterface(0x01ffc9a7));
        assertFalse(pass.supportsInterface(0xffffffff));
        assertEq(pass.name(), "Lortnoc Demo Pass");
        assertEq(pass.symbol(), "LDP");
        pass.mint();
        assertGt(bytes(pass.tokenURI(1)).length, 0);
    }
}
