const anchor = require("@project-serum/anchor");
const assert = require("assert");
const {setProvider} = require("@project-serum/anchor");
const buffer = require("buffer");

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
    await program.provider.connection.requestAirdrop(multisigSigner, 1000000000000);
    const ownerB = anchor.web3.Keypair.generate();
    const ownerC = anchor.web3.Keypair.generate();
    const owners = [program.provider.wallet.publicKey, ownerB.publicKey, ownerC.publicKey];
    const name = "test";
    let remainingAccounts = [];
    let bumps = [];

    for (const owner of owners) {
      const [pubkey, bump] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("ownership"), multisig.publicKey.toBuffer(), owner.toBuffer()],
        program.programId
      );
      remainingAccounts.push({pubkey, isSigner: false, isWritable: true})
      bumps.push(bump)
    }

    const threshold = new anchor.BN(2);
    await program.rpc.createMultisig(
      {
        owners,
        threshold,
        nonce,
        name,
        bumps: Buffer.from(bumps),
      },
      {
        accounts: {
          multisig: multisig.publicKey,
          owner: program.provider.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY
        },
        signers: [multisig],
        remainingAccounts
      }
    )

    let programAccounts = await program.provider.connection.getProgramAccounts(program.programId);
    assert.equal(programAccounts.length, 4);

    let multisigAccount = await program.account.multisig.fetch(
      multisig.publicKey
    );

    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eqn(2));
    assert.ok(multisigAccount.ownersAmount.eqn(3));
    assert.ok(multisigAccount.ownerSetSeqno === 0);

    // Update owners test
    const pid = program.programId;
    let updateOwnersAccounts = program.instruction.updateOwnersAndThreshold.accounts({
      multisig: multisig.publicKey,
      multisigSigner: multisigSigner,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY
    });

    const newOwner1 = anchor.web3.Keypair.generate();
    const newOwner2 = anchor.web3.Keypair.generate();
    const newOwner3 = anchor.web3.Keypair.generate();
    const newOwner4 = anchor.web3.Keypair.generate();

    // Add four new owners and remove two old owners
    const updateOwners = [
      newOwner1.publicKey,
      newOwner2.publicKey,
      newOwner3.publicKey,
      newOwner4.publicKey,
      ownerB.publicKey,
      ownerC.publicKey,
    ];

    const updateOwnersChangedAccounts = []
    const updateOwnersBumps = []

    for (const updateOwnerPubkey of updateOwners) {
      const [newOwnerPubkey, bump] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("ownership"), multisig.publicKey.toBuffer(), updateOwnerPubkey.toBuffer()],
        program.programId
      );
      updateOwnersChangedAccounts.push({pubkey: newOwnerPubkey, isSigner: false, isWritable: true});
      updateOwnersBumps.push(bump)
    }
    const data = program.coder.instruction.encode("update_owners_and_threshold",
      {
        args: {
          owners: updateOwners,
          bumps: Buffer.from(updateOwnersBumps),
          threshold
        }
      },
    );

    const txName = "test-tx";
    const transaction = anchor.web3.Keypair.generate();
    const [multisigOwnerPubkey, bump] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("ownership"), multisig.publicKey.toBuffer(), program.provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    updateOwnersAccounts = updateOwnersAccounts.concat(updateOwnersChangedAccounts)

    await program.rpc.createTransaction(
      {
        pid,
        accs: updateOwnersAccounts,
        data,
        name: txName,
      },
      {
        accounts: {
          multisig: multisig.publicKey,
          transaction: transaction.publicKey,
          proposer: program.provider.wallet.publicKey,
          multisigOwner: multisigOwnerPubkey,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [transaction],
      }
    );

    const txAccount = await program.account.transaction.fetch(
      transaction.publicKey
    );

    assert.ok(txAccount.programId.equals(pid));
    assert.deepStrictEqual(txAccount.accounts, updateOwnersAccounts);
    assert.deepStrictEqual(txAccount.data, data);
    assert.ok(txAccount.multisig.equals(multisig.publicKey));
    assert.deepStrictEqual(txAccount.didExecute, false);
    assert.ok(txAccount.ownerSetSeqno === 0);

    // Other owner approves transaction
    const [otherMultisigOwner] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("ownership"), multisig.publicKey.toBuffer(), ownerB.publicKey.toBuffer()],
      program.programId
    );

    await program.rpc.approve({
      accounts: {
        multisig: multisig.publicKey,
        transaction: transaction.publicKey,
        owner: ownerB.publicKey,
        multisigOwner: otherMultisigOwner,
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
      remainingAccounts: program.instruction.updateOwnersAndThreshold
        .accounts({
          multisig: multisig.publicKey,
          multisigSigner,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY
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
        }).concat(updateOwnersChangedAccounts),
    });

    multisigAccount = await program.account.multisig.fetch(multisig.publicKey);

    // five owners (first added three owners, then removed two owners and added four owners)
    assert.strictEqual(multisigAccount.nonce, nonce);
    assert.ok(multisigAccount.threshold.eqn(2));
    assert.ok(multisigAccount.ownersAmount.eqn(5));
    assert.ok(multisigAccount.ownerSetSeqno === 1);

    // search all multisig owners
    let multisig_owners = await program.provider.connection.getProgramAccounts(
      program.programId,
      {
        filters: [
          {
            dataSize: 72,
          },
          {
            memcmp: {
              offset: 8,
              bytes: multisig.publicKey.toBase58()
            },
          },
        ]
      },
    );

    assert.ok(multisigAccount.ownersAmount.eqn(multisig_owners.length));

    // search one multisig owner by owner
    let multisig_owner = await program.provider.connection.getProgramAccounts(
      program.programId,
      {
        filters: [
          {
            dataSize: 72,
          },
          {
            memcmp: {
              offset: 8 + 32,
              bytes: newOwner1.publicKey.toBase58()
            },
          },
        ]
      },
    );

    assert.equal(multisig_owner.length, 1);


  });

  it("Assert Unique Owners", async () => {
    const multisig = anchor.web3.Keypair.generate();
    const [_multisigSigner, nonce] =
      await anchor.web3.PublicKey.findProgramAddress(
        [multisig.publicKey.toBuffer()],
        program.programId
      );

    const ownerA = anchor.web3.Keypair.generate();
    const ownerB = anchor.web3.Keypair.generate();
    const owners = [ownerA.publicKey, ownerB.publicKey, ownerA.publicKey];

    let remainingAccounts = [];
    let bumps = [];
    for (const owner of owners) {
      const [pubkey, bump] = await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("ownership"), multisig.publicKey.toBuffer(), owner.toBuffer()],
        program.programId
      );
      remainingAccounts.push({pubkey, isSigner: false, isWritable: true})
      bumps.push(bump)
    }

    const name = "test";

    const threshold = new anchor.BN(2);
    try {
      await program.rpc.createMultisig(
        {
          owners, threshold, nonce, name, bumps: Buffer.from(bumps),
        },
        {
          accounts: {
            multisig: multisig.publicKey,
            owner: program.provider.wallet.publicKey,
            systemProgram: anchor.web3.SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY
          },
          signers: [multisig],
          remainingAccounts
        }
      );
      assert.fail();
    } catch (err) {
      assert.ok(err.message.includes("0x1778"));
    }
  });
});
