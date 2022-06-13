const anchor = require("@project-serum/anchor");
const assert = require("assert");
const splToken = require('@solana/spl-token');
const {AuthorityType} = require("@solana/spl-token");
const {createTransferCheckedInstruction} = require("@solana/spl-token");
const {getAssociatedTokenAddress, getMint} = require("@solana/spl-token");
const {ASSOCIATED_TOKEN_PROGRAM_ID} = require("@solana/spl-token");
const {TOKEN_PROGRAM_ID} = require("@solana/spl-token");

describe("multisig", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.Provider.env());

  const program = anchor.workspace.Multisig;

  it("Tests the multisig program", async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );

    const ownerB = anchor.web3.Keypair.generate();
    const ownerC = anchor.web3.Keypair.generate();
    const ownerD = anchor.web3.Keypair.generate();
    const owners = [program.provider.wallet.publicKey, ownerB.publicKey, ownerC.publicKey];

    const name = "test";

    const threshold = new anchor.BN(2);
    await program.rpc.createMultisig(
      {
        owners,
        threshold,
        nonce,
        name,
      },
      {
        accounts: {
          multisig: multisig.publicKey,
          owner: program.provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [multisig]
      }
    );

    let multisigAccount = await program.account.multisig.fetch(
      multisig.publicKey
    );
    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
    assert.deepStrictEqual(multisigAccount.owners, owners);
    assert.ok(multisigAccount.ownerSetSeqno === 0);

    const pid = program.programId;
    const accounts = [
      {
        pubkey: multisig.publicKey,
        isWritable: true,
        isSigner: false,
      },
      {
        pubkey: multisigSigner,
        isWritable: false,
        isSigner: true,
      },
    ];
    const newOwners = [program.provider.wallet.publicKey, ownerB.publicKey, ownerD.publicKey];
    const data = program.coder.instruction.encode("set_owners", {
      owners: newOwners,
    });

    const txName = "test-tx";

    const transaction = anchor.web3.Keypair.generate();
    await program.rpc.createTransaction(
      {
        pid,
        accs: accounts,
        data,
        name: txName,
      },
      {
        accounts: {
          multisig: multisig.publicKey,
          transaction: transaction.publicKey,
          proposer: program.provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [transaction],
      }
    );

    const txAccount = await program.account.transaction.fetch(
      transaction.publicKey
    );

    assert.ok(txAccount.programId.equals(pid));
    assert.deepStrictEqual(txAccount.accounts, accounts);
    assert.deepStrictEqual(txAccount.data, data);
    assert.ok(txAccount.multisig.equals(multisig.publicKey));
    assert.deepStrictEqual(txAccount.didExecute, false);
    assert.ok(txAccount.ownerSetSeqno === 0);

    // Other owner approves transactoin.
    await program.rpc.approve({
      accounts: {
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        owner: ownerB.publicKey,
      },
      signers: [ownerB],
    });

    // Now that we've reached the threshold, send the transactoin.
    await program.rpc.executeTransaction({
      accounts: {
        multisig: multisig.publicKey,
        multisigSigner,
        transaction: transaction.publicKey,
      },
      remainingAccounts: program.instruction.setOwners
        .accounts({
          multisig: multisig.publicKey,
          multisigSigner,
        })
        // Change the signer status on the vendor signer since it's signed by the program, not the client.
        .map((meta) =>
          meta.pubkey.equals(multisigSigner)
            ? {...meta, isSigner: false}
            : meta
        )
        .concat({
          pubkey: program.programId,
          isWritable: false,
          isSigner: false,
        }),
    });

    multisigAccount = await program.account.multisig.fetch(multisig.publicKey);

    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eq(new anchor.BN(2)));
    assert.deepStrictEqual(multisigAccount.owners, newOwners);
    assert.ok(multisigAccount.ownerSetSeqno === 1);
  });

  it("Assert Unique Owners", async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [_multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );
    const multisigSize = 200; // Big enough.

    const ownerA = anchor.web3.Keypair.generate();
    const ownerB = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey, ownerB.publicKey, ownerA.publicKey];

    const name = "test";

    const threshold = new anchor.BN(2);
    try {
      await program.rpc.createMultisig(
        {
          owners, threshold, nonce, name
        },
        {
          accounts: {
            multisig: multisig.publicKey,
            owner: program.provider.wallet.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
          },
          signers: [multisig],
        }
      );
      assert.fail();
    } catch (err) {
      assert.ok(err.message.includes("0x1778"));
    }
  });

  it("SPL Transaction", async () => {
    // Step 1: Create multisig
    let provider = program.provider;
    const multisig = anchor.web3.Keypair.generate();

    const [multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );

    const owners = [program.provider.wallet.publicKey];
    const name = "test";
    const threshold = new anchor.BN(1);
    await program.rpc.createMultisig(
      {
        owners,
        threshold,
        nonce,
        name,
      },
      {
        accounts: {
          multisig: multisig.publicKey,
          owner: program.provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [multisig]
      }
    );


    // Step 2: Create mint and two token accounts
    let decimals = 0
    let mintAddress = await splToken.createMint(
      provider.connection,
      provider.wallet.payer,
      provider.wallet.publicKey,
      null,
      decimals,
    );

    const mintTestAddress = new anchor.web3.PublicKey(mintAddress);

    const senderTokenAccount = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      program.provider.wallet.payer,
      mintAddress,
      program.provider.wallet.publicKey
    )

    const receiverTokenAccount = await splToken.getOrCreateAssociatedTokenAccount(
      provider.connection,
      program.provider.wallet.payer,
      mintAddress,
      multisig.publicKey
    )

    // give 100 tokens to sender token accounts
    await splToken.mintTo(
      provider.connection,
      program.provider.wallet.payer,
      mintAddress,
      senderTokenAccount.address,
      program.provider.wallet.payer,
      100
    )

    let mintInfo = await splToken.getMint(provider.connection, mintTestAddress)
    assert.strictEqual(mintInfo.supply, 100n)

    let senderTokenAccountBalance = await provider.connection.getTokenAccountBalance(senderTokenAccount.address);
    let receiverTokenAccountBalance = await provider.connection.getTokenAccountBalance(receiverTokenAccount.address);
    assert.strictEqual(senderTokenAccountBalance.value.amount, '100')
    assert.strictEqual(receiverTokenAccountBalance.value.amount, '0')

    // send 10 tokens from SenderTokenAccount to ReceiverTokenAccount
    await splToken.transferChecked(
      provider.connection,
      program.provider.wallet.payer,
      senderTokenAccount.address,
      senderTokenAccount.mint,
      receiverTokenAccount.address,
      program.provider.wallet.publicKey,
      10,
      mintInfo.decimals)

    senderTokenAccountBalance = await provider.connection.getTokenAccountBalance(senderTokenAccount.address);
    receiverTokenAccountBalance = await provider.connection.getTokenAccountBalance(receiverTokenAccount.address);
    assert.strictEqual(senderTokenAccountBalance.value.amount, '90')
    assert.strictEqual(receiverTokenAccountBalance.value.amount, '10')


    // Step 3: Send money back from ReceiverTokenAccount to SenderTokenAccount by multisig
    const newTransaction = anchor.web3.Keypair.generate();

    // Change authority. Set owner of ReceiverTokenAccount to multisigSigner
    await splToken.setAuthority(
      provider.connection,
      program.provider.wallet.payer,
      receiverTokenAccount.address,
      multisig,
      AuthorityType.AccountOwner,
      multisigSigner
    )

    let transferInstruction = createTransferCheckedInstruction(
      receiverTokenAccount.address,
      receiverTokenAccount.mint,
      senderTokenAccount.address,
      multisigSigner,
      10,
      mintInfo.decimals
    );

    await program.rpc.createTransaction(
      {
        pid: TOKEN_PROGRAM_ID,
        accs: transferInstruction.keys,
        data: transferInstruction.data,
        name: 'transfer_new',
      },
      {
        accounts: {
          multisig: multisig.publicKey,
          transaction: newTransaction.publicKey,
          proposer: provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [newTransaction],
      }
    );

    let remainingAccounts = transferInstruction.keys
      .concat({
        pubkey: TOKEN_PROGRAM_ID,
        isWritable: false,
        isSigner: false,
      })

    // disable all external signers
    remainingAccounts.forEach(it => it.isSigner = false)

    await program.rpc.executeTransaction({
      accounts: {
        multisig: multisig.publicKey,
        multisigSigner,
        transaction: newTransaction.publicKey,
      },
      remainingAccounts,
    });

    senderTokenAccountBalance = await provider.connection.getTokenAccountBalance(senderTokenAccount.address);
    receiverTokenAccountBalance = await provider.connection.getTokenAccountBalance(receiverTokenAccount.address);

    assert.strictEqual(senderTokenAccountBalance.value.amount, '100')
    assert.strictEqual(receiverTokenAccountBalance.value.amount, '0')
  });
});

