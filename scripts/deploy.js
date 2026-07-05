const { ethers } = require("hardhat");

async function main() {
  const [client, freelancer, approver1, approver2, approver3] = await ethers.getSigners();

  const descriptions = ["UI Design", "Backend API", "Deployment"];
  const amounts = [
    ethers.parseEther("0.01"),
    ethers.parseEther("0.01"),
    ethers.parseEther("0.01"),
  ];
  const totalDeposit = amounts.reduce((acc, value) => acc + value, 0n);

  const MilestoneEscrow = await ethers.getContractFactory("MilestoneEscrow");
  const escrow = await MilestoneEscrow.deploy(
    freelancer.address,
    [approver1.address, approver2.address, approver3.address],
    2,
    descriptions,
    amounts,
    { value: totalDeposit }
  );

  await escrow.waitForDeployment();

  console.log("MilestoneEscrow deployed to:", await escrow.getAddress());
  console.log("Client:", client.address);
  console.log("Freelancer:", freelancer.address);
  console.log("Approver 1:", approver1.address);
  console.log("Approver 2:", approver2.address);
  console.log("Approver 3:", approver3.address);
  console.log("Total locked ETH:", ethers.formatEther(totalDeposit));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
