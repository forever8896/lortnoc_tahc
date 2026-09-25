// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LortnocSpaces} from "../src/LortnocSpaces.sol";

contract RejectingTreasury {
    receive() external payable {
        revert("no");
    }
}

contract LortnocSpacesTest is Test {
    LortnocSpaces spaces;
    address treasury = makeAddr("treasury");
    address owner = makeAddr("coldOwner");
    address buyer = makeAddr("buyer");
    address creator = makeAddr("creator");
    uint256 constant PRICE = 0.005 ether;
    bytes32 constant RULES = keccak256("rules");

    event SpaceBought(
        uint256 indexed id, string label, address indexed spaceOwner, bytes32 rulesHash, address indexed payer, uint256 price
    );

    function setUp() public {
        spaces = new LortnocSpaces(PRICE, treasury, owner);
        vm.deal(buyer, 1 ether);
    }

    function test_buy_paysTreasury_emits_andHoldsNothing() public {
        vm.expectEmit(true, true, true, true);
        emit SpaceBought(1, "lentil-club", creator, RULES, buyer, PRICE);
        vm.prank(buyer);
        uint256 id = spaces.buySpace{value: PRICE}("lentil-club", creator, RULES);
        assertEq(id, 1);
        assertEq(treasury.balance, PRICE);
        assertEq(address(spaces).balance, 0);
        assertFalse(spaces.available("lentil-club"));
    }

    function test_overpayment_isRefunded() public {
        vm.prank(buyer);
        spaces.buySpace{value: 0.02 ether}("lentil-club", creator, RULES);
        assertEq(treasury.balance, PRICE);
        assertEq(buyer.balance, 1 ether - PRICE);
        assertEq(address(spaces).balance, 0);
    }

    function test_underpayment_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LortnocSpaces.Underpaid.selector, PRICE - 1, PRICE));
        spaces.buySpace{value: PRICE - 1}("lentil-club", creator, RULES);
    }

    function test_label_isNeverSoldTwice() public {
        vm.prank(buyer);
        spaces.buySpace{value: PRICE}("lentil-club", creator, RULES);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LortnocSpaces.LabelTaken.selector, "lentil-club"));
        spaces.buySpace{value: PRICE}("lentil-club", buyer, RULES);
    }

    function test_labelRule_matchesTheRelayer() public view {
        assertTrue(spaces.validLabel("abc"));
        assertTrue(spaces.validLabel("a-1-b"));
        assertTrue(spaces.validLabel("abcdefghijklmnopqrstuvwxyz012345")); // 32
        assertFalse(spaces.validLabel("ab"));
        assertFalse(spaces.validLabel("abcdefghijklmnopqrstuvwxyz0123456")); // 33
        assertFalse(spaces.validLabel("-abc"));
        assertFalse(spaces.validLabel("abc-"));
        assertFalse(spaces.validLabel("Abc"));
        assertFalse(spaces.validLabel("a.bc"));
        assertFalse(spaces.validLabel("a bc"));
        assertFalse(spaces.validLabel(unicode"café"));
    }

    function test_invalidLabel_orZeroOwner_reverts() public {
        vm.startPrank(buyer);
        vm.expectRevert(LortnocSpaces.InvalidLabel.selector);
        spaces.buySpace{value: PRICE}("Lentil", creator, RULES);
        vm.expectRevert(LortnocSpaces.ZeroAddress.selector);
        spaces.buySpace{value: PRICE}("lentil", address(0), RULES);
        vm.stopPrank();
    }

    function test_failedTreasuryTransfer_revertsWholePurchase() public {
        RejectingTreasury bad = new RejectingTreasury();
        vm.prank(owner);
        spaces.setTreasury(address(bad));
        vm.prank(buyer);
        vm.expectRevert(LortnocSpaces.TransferFailed.selector);
        spaces.buySpace{value: PRICE}("lentil-club", creator, RULES);
        assertTrue(spaces.available("lentil-club"), "a failed purchase must not burn the label");
    }

    function test_onlyOwner_setsPriceAndTreasury() public {
        vm.expectRevert(LortnocSpaces.NotOwner.selector);
        spaces.setPrice(1);
        vm.expectRevert(LortnocSpaces.NotOwner.selector);
        spaces.setTreasury(buyer);
        vm.prank(owner);
        spaces.setPrice(0.01 ether);
        assertEq(spaces.price(), 0.01 ether);
    }

    function test_priceChange_appliesToNextPurchase() public {
        vm.prank(owner);
        spaces.setPrice(0.01 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(LortnocSpaces.Underpaid.selector, PRICE, 0.01 ether));
        spaces.buySpace{value: PRICE}("lentil-club", creator, RULES);
    }

    function testFuzz_buy_neverKeepsFunds(uint96 sent) public {
        vm.assume(sent >= PRICE && sent <= 1 ether);
        vm.prank(buyer);
        spaces.buySpace{value: sent}("fuzz-space", creator, RULES);
        assertEq(address(spaces).balance, 0);
        assertEq(treasury.balance, PRICE);
    }
}
