import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import contractInfo from "./contractInfo.json";

const STATUS_LABELS = ["Not Submitted", "Submitted", "Disputed", "Resubmitted", "Paid"];
const ZERO = "0x0000000000000000000000000000000000000000";

function short(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function same(a, b) {
  return (a || "").toLowerCase() === (b || "").toLowerCase();
}

function formatEth(value) {
  try {
    return Number(ethers.formatEther(value || 0n)).toFixed(4);
  } catch {
    return "0.0000";
  }
}

function asInt(value) {
  return Number(value ?? 0n);
}

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState("");
  const [contract, setContract] = useState(null);
  const [readContract, setReadContract] = useState(null);
  const [role, setRole] = useState("Not connected");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);
  const [selectedMilestone, setSelectedMilestone] = useState(0);
  const [proof, setProof] = useState("ipfs://demo-proof-or-github-link");
  const [disputeMessage, setDisputeMessage] = useState("The submitted work is incomplete. Please add test evidence.");
  const [response, setResponse] = useState("I fixed the issue and added the requested test evidence.");
  const [newProof, setNewProof] = useState("ipfs://updated-demo-proof-or-github-link");

  const contractAddress = contractInfo.address;
  const contractAbi = contractInfo.abi;

  const hasDeployment = useMemo(() => {
    return contractAddress && contractAddress !== ZERO && Array.isArray(contractAbi) && contractAbi.length > 0;
  }, [contractAddress, contractAbi]);

  async function connectWallet() {
    if (!window.ethereum) {
      setStatus("MetaMask not found. Install MetaMask first.");
      return;
    }
    if (!hasDeployment) {
      setStatus("Contract info is missing. Run npm run deploy:local first.");
      return;
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    await browserProvider.send("eth_requestAccounts", []);
    const network = await browserProvider.getNetwork();
    if (Number(network.chainId) !== 31337) {
      setStatus(`Wrong network. Please switch MetaMask to Hardhat Local / chainId 31337. Current chainId: ${network.chainId}`);
      return;
    }

    const walletSigner = await browserProvider.getSigner();
    const user = await walletSigner.getAddress();
    const write = new ethers.Contract(contractAddress, contractAbi, walletSigner);
    const read = new ethers.Contract(contractAddress, contractAbi, browserProvider);

    setProvider(browserProvider);
    setSigner(walletSigner);
    setAccount(user);
    setContract(write);
    setReadContract(read);
    setStatus("Wallet connected.");
  }

  async function refresh() {
    const c = contract || readContract;
    if (!c || !provider) return;

    try {
      const [client, freelancer, approvers, balance, projectReady, allPaid] = await Promise.all([
        c.client(),
        c.freelancer(),
        c.getApprovers(),
        c.getContractBalance(),
        c.projectReady(),
        c.allMilestonesPaid(),
      ]);

      const constants = {
        milestonePayment: await c.MILESTONE_PAYMENT(),
        approverStake: await c.APPROVER_STAKE(),
        clientReward: await c.CLIENT_REWARD_PER_APPROVER(),
        freelancerReward: await c.FREELANCER_REWARD_PER_APPROVER(),
        freelancerReserve: await c.TOTAL_FREELANCER_REWARD_RESERVE(),
        threshold: await c.APPROVAL_THRESHOLD(),
        f: await c.FAULT_TOLERANCE_F(),
        approverCount: await c.APPROVER_COUNT(),
      };

      const accountRole = account ? await c.getRole(account) : "Not connected";
      const milestones = [];
      for (let i = 0; i < 3; i++) {
        const m = await c.getMilestone(i);
        const perApprover = [];
        for (const a of approvers) {
          const [approved, disputed, message, reward, staked, nativeBalance] = await Promise.all([
            c.hasApproved(i, a),
            c.hasDisputed(i, a),
            c.getDisputeMessage(i, a),
            c.approverRewardBalance(a),
            c.hasStaked(a),
            provider.getBalance(a),
          ]);
          perApprover.push({ address: a, approved, disputed, message, reward, staked, nativeBalance });
        }
        milestones.push({
          id: i,
          description: m.description,
          proofURI: m.proofURI,
          responseURI: m.responseURI,
          status: Number(m.status),
          approvalCount: Number(m.approvalCount),
          disputeCount: Number(m.disputeCount),
          paid: m.paid,
          submittedAt: Number(m.submittedAt),
          paidAt: Number(m.paidAt),
          perApprover,
        });
      }

      const balances = {
        client: await provider.getBalance(client),
        freelancer: await provider.getBalance(freelancer),
        connected: account ? await provider.getBalance(account) : 0n,
      };

      setRole(accountRole);
      setState({
        client,
        freelancer,
        approvers,
        balance,
        projectReady,
        allPaid,
        constants,
        milestones,
        balances,
      });
      setStatus("Data refreshed.");
    } catch (e) {
      console.error(e);
      setStatus(`Read error: ${e.shortMessage || e.message}`);
    }
  }

  async function runTx(label, fn) {
    if (!contract) {
      setStatus("Connect MetaMask first.");
      return;
    }
    setBusy(true);
    setStatus(`${label}: waiting for MetaMask confirmation...`);
    try {
      const tx = await fn();
      setStatus(`${label}: transaction sent ${tx.hash}. Waiting for confirmation...`);
      await tx.wait();
      setStatus(`${label}: confirmed.`);
      await refresh();
    } catch (e) {
      console.error(e);
      setStatus(`${label} failed: ${e.shortMessage || e.reason || e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function stakeAsApprover() {
    await runTx("Stake as approver", () =>
      contract.stakeAsApprover({ value: ethers.parseEther("5") })
    );
  }

  async function depositFreelancerReserve() {
    await runTx("Deposit freelancer reward reserve", () =>
      contract.depositFreelancerRewardReserve({ value: ethers.parseEther("9") })
    );
  }

  async function submitMilestone() {
    await runTx("Submit milestone", () =>
      contract.submitMilestone(selectedMilestone, proof)
    );
  }

  async function approveMilestone(id = selectedMilestone) {
    await runTx("Approve milestone", () => contract.approveMilestone(id));
  }

  async function raiseDispute(id = selectedMilestone) {
    await runTx("Raise dispute", () => contract.raiseDispute(id, disputeMessage));
  }

  async function respondAndResubmit(id = selectedMilestone) {
    await runTx("Respond and resubmit", () =>
      contract.respondAndResubmit(id, response, newProof)
    );
  }

  async function claimRewards() {
    await runTx("Claim rewards and stake", () => contract.claimApproverRewardsAndStake());
  }

  useEffect(() => {
    if (!window.ethereum) return;
    const handler = () => window.location.reload();
    window.ethereum.on?.("accountsChanged", handler);
    window.ethereum.on?.("chainChanged", handler);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", handler);
      window.ethereum.removeListener?.("chainChanged", handler);
    };
  }, []);

  useEffect(() => {
    if (contract && provider) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract, provider]);

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Ethereum Smart Contract Demo</p>
          <h1>Byzantine SmartEscrow</h1>
          <p>
            Milestone escrow with 4 approvers, 3-of-4 Byzantine-resilient approval, approver staking,
            dispute messages, resubmission, and reward distribution.
          </p>
        </div>
        <div className="wallet-card">
          <button onClick={connectWallet} disabled={busy}>{account ? "Reconnect" : "Connect MetaMask"}</button>
          <button className="secondary" onClick={refresh} disabled={!contract || busy}>Refresh</button>
          <p><b>Account:</b> {account ? short(account) : "Not connected"}</p>
          <p><b>Role:</b> {role}</p>
          <p><b>Network:</b> Hardhat Local, chainId 31337</p>
        </div>
      </header>

      {!hasDeployment && (
        <section className="warning">
          Contract ABI/address missing. Run <code>npm run deploy:local</code> from the root project folder before starting the frontend.
        </section>
      )}

      <section className="statusbar">
        <b>Status:</b> {status || "Ready."}
      </section>

      <nav className="tabs">
        <button className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>Dashboard</button>
        <button className={page === "freelancer" ? "active" : ""} onClick={() => setPage("freelancer")}>Freelancer Page</button>
        <button className={page === "approver" ? "active" : ""} onClick={() => setPage("approver")}>Approver Page</button>
      </nav>

      {page === "dashboard" && <Dashboard state={state} contractAddress={contractAddress} stakeAsApprover={stakeAsApprover} depositFreelancerReserve={depositFreelancerReserve} busy={busy} />}
      {page === "freelancer" && <FreelancerPage state={state} account={account} selectedMilestone={selectedMilestone} setSelectedMilestone={setSelectedMilestone} proof={proof} setProof={setProof} response={response} setResponse={setResponse} newProof={newProof} setNewProof={setNewProof} submitMilestone={submitMilestone} respondAndResubmit={respondAndResubmit} depositFreelancerReserve={depositFreelancerReserve} busy={busy} />}
      {page === "approver" && <ApproverPage state={state} account={account} selectedMilestone={selectedMilestone} setSelectedMilestone={setSelectedMilestone} disputeMessage={disputeMessage} setDisputeMessage={setDisputeMessage} approveMilestone={approveMilestone} raiseDispute={raiseDispute} stakeAsApprover={stakeAsApprover} claimRewards={claimRewards} busy={busy} />}
    </div>
  );
}

function Dashboard({ state, contractAddress, stakeAsApprover, depositFreelancerReserve, busy }) {
  if (!state) return <EmptyState />;
  const c = state.constants;
  return (
    <main className="grid two">
      <section className="card">
        <h2>Project Setup</h2>
        <p><b>Contract:</b> {contractAddress}</p>
        <p><b>Client:</b> {state.client}</p>
        <p><b>Freelancer:</b> {state.freelancer}</p>
        <p><b>Contract balance:</b> {formatEth(state.balance)} ETH</p>
        <p><b>Project ready:</b> {state.projectReady ? "Yes" : "No"}</p>
        <p><b>All milestones paid:</b> {state.allPaid ? "Yes" : "No"}</p>
      </section>

      <section className="card accent">
        <h2>Byzantine Agreement Rule</h2>
        <p>This application uses a committee decision rule at the smart-contract layer.</p>
        <div className="formula">n = {asInt(c.approverCount)}, f = {asInt(c.f)}, threshold = 2f + 1 = {asInt(c.threshold)}</div>
        <p>With 4 approvers and a 3-of-4 threshold, the system can tolerate one faulty or dishonest approver.</p>
      </section>

      <section className="card">
        <h2>Economic Rules</h2>
        <ul>
          <li>Each Hardhat account starts with <b>100 ETH</b>.</li>
          <li>Client locks <b>48 ETH</b> at deployment.</li>
          <li>Freelancer deposits <b>{formatEth(c.freelancerReserve)} ETH</b> reward reserve.</li>
          <li>Each approver stakes <b>{formatEth(c.approverStake)} ETH</b>.</li>
          <li>Freelancer receives <b>{formatEth(c.milestonePayment)} ETH</b> per paid milestone.</li>
          <li>Each approving approver earns <b>3 ETH</b> per paid milestone: 2 ETH client + 1 ETH freelancer.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Activation Actions</h2>
        <p>Approvers must stake before voting. Freelancer must deposit reward reserve before submitting work.</p>
        <button onClick={stakeAsApprover} disabled={busy}>Stake 5 ETH as Approver</button>
        <button onClick={depositFreelancerReserve} disabled={busy}>Freelancer Deposit 9 ETH Reserve</button>
      </section>

      <section className="card wide">
        <h2>Approver Committee</h2>
        <div className="table">
          <div className="row header"><span>Approver</span><span>Staked?</span><span>Reward Balance</span><span>Wallet Balance</span></div>
          {state.approvers.map((a, i) => {
            const info = state.milestones[0].perApprover.find((x) => same(x.address, a));
            return <div className="row" key={a}><span>Approver {i + 1}: {short(a)}</span><span>{info?.staked ? "Yes" : "No"}</span><span>{formatEth(info?.reward)} ETH</span><span>{formatEth(info?.nativeBalance)} ETH</span></div>;
          })}
        </div>
      </section>

      <MilestoneList state={state} />
    </main>
  );
}

function FreelancerPage(props) {
  const { state, account, selectedMilestone, setSelectedMilestone, proof, setProof, response, setResponse, newProof, setNewProof, submitMilestone, respondAndResubmit, depositFreelancerReserve, busy } = props;
  if (!state) return <EmptyState />;
  const isFreelancer = same(account, state.freelancer);
  const disputes = state.milestones.flatMap((m) => m.perApprover.filter((a) => a.disputed && a.message).map((a) => ({ milestone: m, approver: a })));
  const selected = state.milestones[selectedMilestone];

  return (
    <main className="grid two">
      <section className="card">
        <h2>Freelancer Page</h2>
        <p><b>Your role active?</b> {isFreelancer ? "Yes" : "No — switch MetaMask to Freelancer account"}</p>
        <p><b>Freelancer wallet:</b> {state.freelancer}</p>
        <p><b>Freelancer wallet balance:</b> {formatEth(state.balances.freelancer)} ETH</p>
        <p><b>Connected wallet balance:</b> {formatEth(state.balances.connected)} ETH</p>
        <button onClick={depositFreelancerReserve} disabled={busy || !isFreelancer}>Deposit 9 ETH Reward Reserve</button>
      </section>

      <section className="card notice">
        <h2>Freelancer Notifications</h2>
        {disputes.length === 0 ? <p>No active dispute notifications.</p> : disputes.map(({ milestone, approver }) => (
          <div className="notification danger" key={`${milestone.id}-${approver.address}`}>
            <b>Dispute on Milestone {milestone.id}</b>
            <p>From {short(approver.address)}: {approver.message}</p>
          </div>
        ))}
      </section>

      <section className="card wide">
        <h2>Submit or Resubmit Work</h2>
        <label>Milestone</label>
        <select value={selectedMilestone} onChange={(e) => setSelectedMilestone(Number(e.target.value))}>
          {state.milestones.map((m) => <option key={m.id} value={m.id}>Milestone {m.id}: {m.description}</option>)}
        </select>
        <p><b>Status:</b> {STATUS_LABELS[selected.status]}</p>
        <p><b>Approvals received:</b> {selected.approvalCount} / {asInt(state.constants.threshold)}</p>
        <p><b>Disputes:</b> {selected.disputeCount}</p>

        <label>Proof URI / GitHub link / IPFS CID</label>
        <input value={proof} onChange={(e) => setProof(e.target.value)} />
        <button onClick={submitMilestone} disabled={busy || !isFreelancer}>Submit Milestone</button>

        <hr />
        <label>Response to dispute</label>
        <textarea value={response} onChange={(e) => setResponse(e.target.value)} />
        <label>New proof URI / updated work link</label>
        <input value={newProof} onChange={(e) => setNewProof(e.target.value)} />
        <button onClick={() => respondAndResubmit(selectedMilestone)} disabled={busy || !isFreelancer}>Respond and Resubmit</button>
      </section>

      <MilestoneList state={state} />
    </main>
  );
}

function ApproverPage(props) {
  const { state, account, selectedMilestone, setSelectedMilestone, disputeMessage, setDisputeMessage, approveMilestone, raiseDispute, stakeAsApprover, claimRewards, busy } = props;
  if (!state) return <EmptyState />;
  const approverInfo = state.milestones[0].perApprover.find((a) => same(a.address, account));
  const isApprover = Boolean(approverInfo);
  const isStaked = Boolean(approverInfo?.staked);
  const pending = state.milestones.filter((m) => (m.status === 1 || m.status === 3) && !m.perApprover.find((a) => same(a.address, account))?.approved && !m.perApprover.find((a) => same(a.address, account))?.disputed);
  const approved = state.milestones.filter((m) => m.perApprover.find((a) => same(a.address, account))?.approved);
  const disputed = state.milestones.filter((m) => m.perApprover.find((a) => same(a.address, account))?.disputed);
  const selected = state.milestones[selectedMilestone];

  return (
    <main className="grid two">
      <section className="card">
        <h2>Approver Page</h2>
        <p><b>Approver account?</b> {isApprover ? "Yes" : "No — switch MetaMask to an approver account"}</p>
        <p><b>Staked?</b> {isStaked ? "Yes" : "No"}</p>
        <p><b>Reward balance:</b> {formatEth(approverInfo?.reward)} ETH</p>
        <p><b>Connected wallet balance:</b> {formatEth(state.balances.connected)} ETH</p>
        <button onClick={stakeAsApprover} disabled={busy || !isApprover || isStaked}>Stake 5 ETH</button>
        <button onClick={claimRewards} disabled={busy || !isApprover || !state.allPaid}>Claim Rewards + Stake After Job Completion</button>
      </section>

      <section className="card notice">
        <h2>Approver Notifications</h2>
        {pending.length === 0 ? <p>No pending milestone requiring your review.</p> : pending.map((m) => (
          <div className="notification" key={m.id}>
            <b>Milestone {m.id} submitted for review</b>
            <p>{m.description}</p>
            <p>Proof: {m.proofURI || "No proof"}</p>
          </div>
        ))}
        {approved.map((m) => <div className="notification success" key={`a-${m.id}`}>You approved Milestone {m.id}.</div>)}
        {disputed.map((m) => <div className="notification danger" key={`d-${m.id}`}>You disputed Milestone {m.id}.</div>)}
      </section>

      <section className="card wide">
        <h2>Review Milestone</h2>
        <label>Milestone</label>
        <select value={selectedMilestone} onChange={(e) => setSelectedMilestone(Number(e.target.value))}>
          {state.milestones.map((m) => <option key={m.id} value={m.id}>Milestone {m.id}: {m.description}</option>)}
        </select>
        <p><b>Status:</b> {STATUS_LABELS[selected.status]}</p>
        <p><b>Proof:</b> {selected.proofURI || "No proof submitted yet"}</p>
        <p><b>Freelancer response:</b> {selected.responseURI || "No response yet"}</p>
        <p><b>Approvals:</b> {selected.approvalCount} / {asInt(state.constants.threshold)}</p>

        <button onClick={() => approveMilestone(selectedMilestone)} disabled={busy || !isApprover || !isStaked}>Approve Milestone</button>
        <label>Dispute message</label>
        <textarea value={disputeMessage} onChange={(e) => setDisputeMessage(e.target.value)} />
        <button className="dangerBtn" onClick={() => raiseDispute(selectedMilestone)} disabled={busy || !isApprover || !isStaked}>Raise Dispute</button>
      </section>

      <MilestoneList state={state} />
    </main>
  );
}

function MilestoneList({ state }) {
  return (
    <section className="card wide">
      <h2>Milestones</h2>
      <div className="milestones">
        {state.milestones.map((m) => (
          <div className="milestone" key={m.id}>
            <h3>Milestone {m.id}: {m.description}</h3>
            <p><b>Status:</b> {STATUS_LABELS[m.status]}</p>
            <p><b>Proof:</b> {m.proofURI || "Not submitted"}</p>
            <p><b>Response:</b> {m.responseURI || "None"}</p>
            <p><b>Approvals:</b> {m.approvalCount} / {asInt(state.constants.threshold)} | <b>Disputes:</b> {m.disputeCount}</p>
            <div className="miniTable">
              {m.perApprover.map((a, idx) => (
                <div key={a.address} className="miniRow">
                  <span>Approver {idx + 1} {short(a.address)}</span>
                  <span>{a.approved ? "Approved" : a.disputed ? "Disputed" : "No vote"}</span>
                  <span>Reward {formatEth(a.reward)} ETH</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <main className="card">
      <h2>No contract data loaded yet</h2>
      <p>Start Hardhat, deploy the contract, connect MetaMask, and click Refresh.</p>
    </main>
  );
}
