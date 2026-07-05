const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MilestoneEscrow", function () {
  async function deployFixture() {
    const [client, freelancer, approver1, approver2, approver3, outsider] = await ethers.getSigners();

    const descriptions = ["UI Design", "Backend API", "Deployment"];
    const amounts = [
      ethers.parseEther("1.0"),
      ethers.parseEther("1.0"),
      ethers.parseEther("1.0"),
    ];
    const totalDeposit = amounts.reduce((acc, value) => acc + value, 0n);

    const MilestoneEscrow = await ethers.getContractFactory("MilestoneEscrow");
    const escrow = await MilestoneEscrow.connect(client).deploy(
      freelancer.address,
      [approver1.address, approver2.address, approver3.address],
      2,
      descriptions,
      amounts,
      { value: totalDeposit }
    );

    return { escrow, client, freelancer, approver1, approver2, approver3, outsider, amounts, totalDeposit };
  }

  it("deploys fully funded with correct milestone count", async function () {
    const { escrow, client, freelancer, totalDeposit } = await deployFixture();

    expect(await escrow.client()).to.equal(client.address);
    expect(await escrow.freelancer()).to.equal(freelancer.address);
    expect(await escrow.getMilestoneCount()).to.equal(3);
    expect(await escrow.getContractBalance()).to.equal(totalDeposit);
  });

  it("allows freelancer to submit a milestone", async function () {
    const { escrow, freelancer } = await deployFixture();

    await expect(
      escrow.connect(freelancer).submitMilestone(0, "ipfs://QmMilestone1")
    ).to.emit(escrow, "MilestoneSubmitted");

    const milestone = await escrow.getMilestone(0);
    expect(milestone.proofURI).to.equal("ipfs://QmMilestone1");
    expect(milestone.status).to.equal(1); // Submitted
  });

  it("rejects submission from non-freelancer", async function () {
    const { escrow, outsider } = await deployFixture();

    await expect(
      escrow.connect(outsider).submitMilestone(0, "ipfs://fake")
    ).to.be.revertedWith("Only freelancer can call this");
  });

  it("releases payment after approval threshold is reached", async function () {
    const { escrow, freelancer, approver1, approver2, amounts } = await deployFixture();

    await escrow.connect(freelancer).submitMilestone(0, "https://github.com/example/project/commit/abc123");

    await escrow.connect(approver1).approveMilestone(0);
    await expect(
      escrow.connect(approver2).approveMilestone(0)
    ).to.changeEtherBalances(
      [escrow, freelancer],
      [-amounts[0], amounts[0]]
    );

    const milestone = await escrow.getMilestone(0);
    expect(milestone.status).to.equal(2); // Paid
    expect(milestone.amount).to.equal(0);
  });

  it("prevents duplicate approval by same approver", async function () {
    const { escrow, freelancer, approver1 } = await deployFixture();

    await escrow.connect(freelancer).submitMilestone(0, "ipfs://QmMilestone1");
    await escrow.connect(approver1).approveMilestone(0);

    await expect(
      escrow.connect(approver1).approveMilestone(0)
    ).to.be.revertedWith("Approver already voted");
  });

  it("rejects approval by outsider", async function () {
    const { escrow, freelancer, outsider } = await deployFixture();

    await escrow.connect(freelancer).submitMilestone(0, "ipfs://QmMilestone1");

    await expect(
      escrow.connect(outsider).approveMilestone(0)
    ).to.be.revertedWith("Only approver can call this");
  });

  it("allows a submitted milestone to be disputed and refunded", async function () {
    const { escrow, client, freelancer, approver1, amounts } = await deployFixture();

    await escrow.connect(freelancer).submitMilestone(1, "ipfs://QmMilestone2");
    await escrow.connect(approver1).raiseDispute(1, "Deliverable incomplete");

    const disputed = await escrow.getMilestone(1);
    expect(disputed.status).to.equal(3); // Disputed

    await expect(
      escrow.connect(client).refundDisputedMilestone(1)
    ).to.changeEtherBalances(
      [escrow, client],
      [-amounts[1], amounts[1]]
    );

    const refunded = await escrow.getMilestone(1);
    expect(refunded.status).to.equal(4); // Refunded
  });
});
