// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MilestoneEscrow
 * @notice A client locks project funds in this contract. A freelancer submits milestone work.
 * Multiple approvers review each milestone. When the approval threshold is reached, the
 * milestone payment is automatically released to the freelancer. Approvers can also raise
 * disputes with messages; the freelancer can respond and resubmit the milestone.
 */
contract MilestoneEscrow is ReentrancyGuard {
    enum MilestoneStatus {
        Created,
        Submitted,
        Paid,
        Disputed,
        Refunded
    }

    struct Milestone {
        string description;
        uint256 amount;
        string proofURI;
        string freelancerResponse;
        uint256 approvalCount;
        uint256 submissionVersion;
        MilestoneStatus status;
    }

    struct Dispute {
        address raisedBy;
        string reason;
        string freelancerResponse;
        bool resolved;
        uint256 timestamp;
    }

    address public immutable client;
    address payable public immutable freelancer;
    uint256 public immutable approvalThreshold;
    uint256 public immutable createdAt;

    address[] private approverList;
    mapping(address => bool) public isApprover;

    // Instead of a simple boolean, store the milestone submission version approved by each approver.
    // This allows approvals to reset cleanly after a freelancer resubmits disputed work.
    mapping(uint256 => mapping(address => uint256)) private approvedSubmissionVersion;

    Milestone[] private milestones;
    mapping(uint256 => Dispute[]) private disputes;

    event ContractFunded(address indexed client, uint256 totalAmount);
    event MilestoneSubmitted(uint256 indexed milestoneId, uint256 submissionVersion, string proofURI);
    event MilestoneApproved(uint256 indexed milestoneId, address indexed approver, uint256 approvalCount);
    event MilestonePaid(uint256 indexed milestoneId, address indexed freelancer, uint256 amount);
    event MilestoneDisputed(uint256 indexed milestoneId, address indexed raisedBy, string reason);
    event DisputeResponded(uint256 indexed milestoneId, address indexed freelancer, string response);
    event MilestoneResubmitted(uint256 indexed milestoneId, uint256 submissionVersion, string proofURI, string response);
    event MilestoneRefunded(uint256 indexed milestoneId, address indexed client, uint256 amount);

    modifier onlyClient() {
        require(msg.sender == client, "Only client can call this");
        _;
    }

    modifier onlyFreelancer() {
        require(msg.sender == freelancer, "Only freelancer can call this");
        _;
    }

    modifier onlyApprover() {
        require(isApprover[msg.sender], "Only approver can call this");
        _;
    }

    modifier validMilestone(uint256 milestoneId) {
        require(milestoneId < milestones.length, "Invalid milestone");
        _;
    }

    /**
     * @param _freelancer Freelancer/payee wallet address.
     * @param _approvers Addresses allowed to approve submitted milestones.
     * @param _approvalThreshold Number of approvals needed to release a milestone payment.
     * @param _descriptions Human-readable milestone descriptions.
     * @param _amounts ETH amounts in wei for each milestone.
     *
     * msg.value must equal the sum of all milestone amounts, so the contract is fully funded at deployment.
     */
    constructor(
        address payable _freelancer,
        address[] memory _approvers,
        uint256 _approvalThreshold,
        string[] memory _descriptions,
        uint256[] memory _amounts
    ) payable {
        require(_freelancer != address(0), "Freelancer cannot be zero address");
        require(_approvers.length > 0, "At least one approver required");
        require(_approvalThreshold > 0 && _approvalThreshold <= _approvers.length, "Invalid approval threshold");
        require(_descriptions.length > 0, "At least one milestone required");
        require(_descriptions.length == _amounts.length, "Milestone data length mismatch");

        client = msg.sender;
        freelancer = _freelancer;
        approvalThreshold = _approvalThreshold;
        createdAt = block.timestamp;

        for (uint256 i = 0; i < _approvers.length; i++) {
            address approver = _approvers[i];
            require(approver != address(0), "Approver cannot be zero address");
            require(!isApprover[approver], "Duplicate approver");
            isApprover[approver] = true;
            approverList.push(approver);
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < _descriptions.length; i++) {
            require(_amounts[i] > 0, "Milestone amount must be greater than zero");
            milestones.push(
                Milestone({
                    description: _descriptions[i],
                    amount: _amounts[i],
                    proofURI: "",
                    freelancerResponse: "",
                    approvalCount: 0,
                    submissionVersion: 0,
                    status: MilestoneStatus.Created
                })
            );
            totalAmount += _amounts[i];
        }

        require(msg.value == totalAmount, "Deposit must equal total milestone amount");
        emit ContractFunded(msg.sender, msg.value);
    }

    function submitMilestone(uint256 milestoneId, string calldata proofURI)
        external
        onlyFreelancer
        validMilestone(milestoneId)
    {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Created, "Milestone cannot be submitted");
        require(bytes(proofURI).length > 0, "Proof URI required");

        milestone.proofURI = proofURI;
        milestone.freelancerResponse = "";
        milestone.approvalCount = 0;
        milestone.submissionVersion += 1;
        milestone.status = MilestoneStatus.Submitted;

        emit MilestoneSubmitted(milestoneId, milestone.submissionVersion, proofURI);
    }

    function approveMilestone(uint256 milestoneId)
        external
        onlyApprover
        validMilestone(milestoneId)
        nonReentrant
    {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Submitted, "Milestone is not under review");
        require(
            approvedSubmissionVersion[milestoneId][msg.sender] != milestone.submissionVersion,
            "Approver already approved this submission"
        );

        approvedSubmissionVersion[milestoneId][msg.sender] = milestone.submissionVersion;
        milestone.approvalCount += 1;

        emit MilestoneApproved(milestoneId, msg.sender, milestone.approvalCount);

        if (milestone.approvalCount >= approvalThreshold) {
            _releasePayment(milestoneId);
        }
    }

    function raiseDispute(uint256 milestoneId, string calldata reason)
        external
        onlyApprover
        validMilestone(milestoneId)
    {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Submitted, "Only submitted milestones can be disputed");
        require(bytes(reason).length > 0, "Dispute reason required");

        milestone.status = MilestoneStatus.Disputed;
        disputes[milestoneId].push(
            Dispute({
                raisedBy: msg.sender,
                reason: reason,
                freelancerResponse: "",
                resolved: false,
                timestamp: block.timestamp
            })
        );

        emit MilestoneDisputed(milestoneId, msg.sender, reason);
    }

    function respondToDispute(uint256 milestoneId, string calldata response)
        external
        onlyFreelancer
        validMilestone(milestoneId)
    {
        require(bytes(response).length > 0, "Response required");
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Disputed, "Milestone is not disputed");
        uint256 disputeCount = disputes[milestoneId].length;
        require(disputeCount > 0, "No dispute found");

        Dispute storage latestDispute = disputes[milestoneId][disputeCount - 1];
        latestDispute.freelancerResponse = response;
        milestone.freelancerResponse = response;

        emit DisputeResponded(milestoneId, msg.sender, response);
    }

    function resubmitMilestone(uint256 milestoneId, string calldata newProofURI, string calldata response)
        external
        onlyFreelancer
        validMilestone(milestoneId)
    {
        require(bytes(newProofURI).length > 0, "Proof URI required");
        require(bytes(response).length > 0, "Response required");
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Disputed, "Only disputed milestones can be resubmitted");
        uint256 disputeCount = disputes[milestoneId].length;
        require(disputeCount > 0, "No dispute found");

        Dispute storage latestDispute = disputes[milestoneId][disputeCount - 1];
        latestDispute.freelancerResponse = response;
        latestDispute.resolved = true;

        milestone.proofURI = newProofURI;
        milestone.freelancerResponse = response;
        milestone.approvalCount = 0;
        milestone.submissionVersion += 1;
        milestone.status = MilestoneStatus.Submitted;

        emit MilestoneResubmitted(milestoneId, milestone.submissionVersion, newProofURI, response);
    }

    /**
     * @notice Demo dispute resolution: the client can refund a disputed milestone.
     * In a production version, this should be replaced with arbitrator or DAO voting logic.
     */
    function refundDisputedMilestone(uint256 milestoneId)
        external
        onlyClient
        validMilestone(milestoneId)
        nonReentrant
    {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Disputed, "Milestone is not disputed");

        uint256 amount = milestone.amount;
        milestone.status = MilestoneStatus.Refunded;
        milestone.amount = 0;

        (bool success, ) = payable(client).call{value: amount}("");
        require(success, "Refund failed");

        emit MilestoneRefunded(milestoneId, client, amount);
    }

    function _releasePayment(uint256 milestoneId) internal {
        Milestone storage milestone = milestones[milestoneId];
        require(milestone.status == MilestoneStatus.Submitted, "Milestone cannot be paid");

        uint256 amount = milestone.amount;
        milestone.status = MilestoneStatus.Paid;
        milestone.amount = 0;

        (bool success, ) = freelancer.call{value: amount}("");
        require(success, "Payment failed");

        emit MilestonePaid(milestoneId, freelancer, amount);
    }

    function hasApprovedCurrentSubmission(uint256 milestoneId, address approver)
        external
        view
        validMilestone(milestoneId)
        returns (bool)
    {
        Milestone storage milestone = milestones[milestoneId];
        return approvedSubmissionVersion[milestoneId][approver] == milestone.submissionVersion;
    }

    function getMilestone(uint256 milestoneId)
        external
        view
        validMilestone(milestoneId)
        returns (
            string memory description,
            uint256 amount,
            string memory proofURI,
            string memory freelancerResponse,
            uint256 approvalCount,
            uint256 submissionVersion,
            MilestoneStatus status
        )
    {
        Milestone storage milestone = milestones[milestoneId];
        return (
            milestone.description,
            milestone.amount,
            milestone.proofURI,
            milestone.freelancerResponse,
            milestone.approvalCount,
            milestone.submissionVersion,
            milestone.status
        );
    }

    function getDisputeCount(uint256 milestoneId) external view validMilestone(milestoneId) returns (uint256) {
        return disputes[milestoneId].length;
    }

    function getDispute(uint256 milestoneId, uint256 disputeId)
        external
        view
        validMilestone(milestoneId)
        returns (
            address raisedBy,
            string memory reason,
            string memory freelancerResponse,
            bool resolved,
            uint256 timestamp
        )
    {
        require(disputeId < disputes[milestoneId].length, "Invalid dispute");
        Dispute storage dispute = disputes[milestoneId][disputeId];
        return (
            dispute.raisedBy,
            dispute.reason,
            dispute.freelancerResponse,
            dispute.resolved,
            dispute.timestamp
        );
    }

    function getLatestDispute(uint256 milestoneId)
        external
        view
        validMilestone(milestoneId)
        returns (
            bool exists,
            address raisedBy,
            string memory reason,
            string memory freelancerResponse,
            bool resolved,
            uint256 timestamp
        )
    {
        uint256 disputeCount = disputes[milestoneId].length;
        if (disputeCount == 0) {
            return (false, address(0), "", "", false, 0);
        }
        Dispute storage dispute = disputes[milestoneId][disputeCount - 1];
        return (
            true,
            dispute.raisedBy,
            dispute.reason,
            dispute.freelancerResponse,
            dispute.resolved,
            dispute.timestamp
        );
    }

    function getMilestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    function getApprovers() external view returns (address[] memory) {
        return approverList;
    }

    function getContractBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
