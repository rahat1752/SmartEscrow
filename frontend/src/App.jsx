import { useMemo, useState } from "react";
import { ethers } from "ethers";

const DEFAULT_CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const ESCROW_ABI = [
  "function client() view returns (address)",
  "function freelancer() view returns (address)",
  "function approvalThreshold() view returns (uint256)",
  "function getApprovers() view returns (address[])",
  "function getMilestoneCount() view returns (uint256)",
  "function getContractBalance() view returns (uint256)",
  "function getMilestone(uint256 milestoneId) view returns (string description, uint256 amount, string proofURI, uint256 approvalCount, uint8 status)",
  "function submitMilestone(uint256 milestoneId, string proofURI)",
  "function approveMilestone(uint256 milestoneId)",
  "function raiseDispute(uint256 milestoneId, string reason)"
];

const STATUS_LABELS = ["Created", "Submitted", "Paid", "Disputed", "Refunded"];

function shorten(address) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sameAddress(a, b) {
  return a?.toLowerCase() === b?.toLowerCase();
}

export default function App() {
  const [contractAddress, setContractAddress] = useState(DEFAULT_CONTRACT_ADDRESS);
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState("");
  const [contractInfo, setContractInfo] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [selectedMilestone, setSelectedMilestone] = useState("0");
  const [proofURI, setProofURI] = useState("https://github.com/demo/project/commit/abc123");
  const [disputeReason, setDisputeReason] = useState("Milestone needs revision");
  const [message, setMessage] = useState("Connect MetaMask to begin.");
  const [loading, setLoading] = useState(false);

  const role = useMemo(() => {
    if (!account || !contractInfo) return "Not connected";
    if (sameAddress(account, contractInfo.client)) return "Client";
    if (sameAddress(account, contractInfo.freelancer)) return "Freelancer";
    if (contractInfo.approvers?.some((a) => sameAddress(a, account))) return "Approver";
    return "Unknown / unauthorized account";
  }, [account, contractInfo]);

  async function getProviderAndSigner() {
    if (!window.ethereum) {
      throw new Error("MetaMask not found. Install MetaMask extension first.");
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    return { provider, signer };
  }

  async function getContract(readOnly = false) {
    if (!ethers.isAddress(contractAddress)) {
      throw new Error("Invalid contract address.");
    }
    const { provider, signer } = await getProviderAndSigner();
    return new ethers.Contract(contractAddress, ESCROW_ABI, readOnly ? provider : signer);
  }

  async function connectWallet() {
    try {
      setLoading(true);
      const { provider, signer } = await getProviderAndSigner();
      const network = await provider.getNetwork();
      const address = await signer.getAddress();
      setAccount(address);
      setChainId(network.chainId.toString());
      setMessage("Wallet connected. Loading contract data...");
      await refreshData();
    } catch (err) {
      setMessage(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshData() {
    try {
      setLoading(true);
      const { provider, signer } = await getProviderAndSigner();
      const network = await provider.getNetwork();
      const address = await signer.getAddress();
      setAccount(address);
      setChainId(network.chainId.toString());

      const contract = new ethers.Contract(contractAddress, ESCROW_ABI, provider);
      const [client, freelancer, threshold, approvers, balance, count] = await Promise.all([
        contract.client(),
        contract.freelancer(),
        contract.approvalThreshold(),
        contract.getApprovers(),
        contract.getContractBalance(),
        contract.getMilestoneCount()
      ]);

      const loadedMilestones = [];
      for (let i = 0; i < Number(count); i++) {
        const m = await contract.getMilestone(i);
        loadedMilestones.push({
          id: i,
          description: m.description,
          amount: ethers.formatEther(m.amount),
          proofURI: m.proofURI,
          approvalCount: Number(m.approvalCount),
          status: STATUS_LABELS[Number(m.status)] || "Unknown"
        });
      }

      setContractInfo({
        client,
        freelancer,
        approvers,
        threshold: threshold.toString(),
        balance: ethers.formatEther(balance)
      });
      setMilestones(loadedMilestones);
      setMessage("Contract data loaded.");
    } catch (err) {
      setMessage(err.shortMessage || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitMilestone() {
    try {
      setLoading(true);
      const contract = await getContract(false);
      setMessage("Submitting milestone. Confirm the transaction in MetaMask...");
      const tx = await contract.submitMilestone(BigInt(selectedMilestone), proofURI);
      await tx.wait();
      setMessage(`Milestone ${selectedMilestone} submitted successfully.`);
      await refreshData();
    } catch (err) {
      setMessage(err.shortMessage || err.reason || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function approveMilestone() {
    try {
      setLoading(true);
      const contract = await getContract(false);
      setMessage("Approving milestone. Confirm the transaction in MetaMask...");
      const tx = await contract.approveMilestone(BigInt(selectedMilestone));
      await tx.wait();
      setMessage(`Milestone ${selectedMilestone} approved. Payment releases automatically if threshold is met.`);
      await refreshData();
    } catch (err) {
      setMessage(err.shortMessage || err.reason || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function raiseDispute() {
    try {
      setLoading(true);
      const contract = await getContract(false);
      setMessage("Raising dispute. Confirm the transaction in MetaMask...");
      const tx = await contract.raiseDispute(BigInt(selectedMilestone), disputeReason);
      await tx.wait();
      setMessage(`Dispute raised for milestone ${selectedMilestone}.`);
      await refreshData();
    } catch (err) {
      setMessage(err.shortMessage || err.reason || err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Ethereum Smart Contract Demo</p>
          <h1>SmartEscrow: Milestone-Based Payment Release</h1>
          <p>
            Client funds are locked in a smart contract. The freelancer submits work. Approvers vote.
            When the approval threshold is reached, payment is released automatically.
          </p>
        </div>
        <button onClick={connectWallet} disabled={loading}>
          {account ? `Connected: ${shorten(account)}` : "Connect MetaMask"}
        </button>
      </header>

      <section className="card status-card">
        <div>
          <label>Contract Address</label>
          <input
            value={contractAddress}
            onChange={(e) => setContractAddress(e.target.value.trim())}
            placeholder="Paste deployed contract address"
          />
        </div>
        <button onClick={refreshData} disabled={loading}>Refresh Contract Data</button>
        <p className="message">{loading ? "Working..." : message}</p>
      </section>

      <section className="grid">
        <div className="card">
          <h2>Connected Wallet</h2>
          <p><strong>Account:</strong> {account || "Not connected"}</p>
          <p><strong>Network Chain ID:</strong> {chainId || "-"}</p>
          <p><strong>Your Role:</strong> {role}</p>
          <p className={chainId === "31337" ? "ok" : "warning"}>
            {chainId === "31337" ? "Connected to Hardhat Local." : "Use Hardhat Local chain ID 31337 for this demo."}
          </p>
        </div>

        <div className="card">
          <h2>Escrow Contract</h2>
          <p><strong>Client:</strong> {shorten(contractInfo?.client)}</p>
          <p><strong>Freelancer:</strong> {shorten(contractInfo?.freelancer)}</p>
          <p><strong>Approval Threshold:</strong> {contractInfo?.threshold || "-"}</p>
          <p><strong>Locked Balance:</strong> {contractInfo?.balance || "-"} ETH</p>
          <p><strong>Approvers:</strong></p>
          <ul>
            {contractInfo?.approvers?.map((a) => <li key={a}>{shorten(a)}</li>) || <li>-</li>}
          </ul>
        </div>
      </section>

      <section className="card">
        <h2>Milestones</h2>
        <div className="milestone-list">
          {milestones.map((m) => (
            <div className="milestone" key={m.id}>
              <div className="milestone-title">#{m.id}: {m.description}</div>
              <p><strong>Amount:</strong> {m.amount} ETH</p>
              <p><strong>Status:</strong> {m.status}</p>
              <p><strong>Approvals:</strong> {m.approvalCount} / {contractInfo?.threshold || "-"}</p>
              <p><strong>Proof:</strong> {m.proofURI || "Not submitted"}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid">
        <div className="card">
          <h2>1. Freelancer Submits Work</h2>
          <label>Milestone ID</label>
          <input value={selectedMilestone} onChange={(e) => setSelectedMilestone(e.target.value)} />
          <label>Proof URI / Link</label>
          <input value={proofURI} onChange={(e) => setProofURI(e.target.value)} />
          <button onClick={submitMilestone} disabled={loading}>Submit Milestone</button>
          <p className="hint">Use the Freelancer MetaMask account for this action.</p>
        </div>

        <div className="card">
          <h2>2. Approvers Vote</h2>
          <label>Milestone ID</label>
          <input value={selectedMilestone} onChange={(e) => setSelectedMilestone(e.target.value)} />
          <button onClick={approveMilestone} disabled={loading}>Approve Milestone</button>
          <p className="hint">Switch MetaMask to Approver 1, approve, then switch to Approver 2 and approve again.</p>
        </div>
      </section>

      <section className="card">
        <h2>Optional: Raise Dispute</h2>
        <label>Reason</label>
        <input value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} />
        <button className="secondary" onClick={raiseDispute} disabled={loading}>Raise Dispute</button>
        <p className="hint">A dispute can only be raised after a milestone is submitted and before it is paid.</p>
      </section>
    </div>
  );
}
