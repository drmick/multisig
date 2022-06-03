//! An example of a multisig to execute arbitrary Solana transactions.
//!
//! This program can be used to allow a multisig to govern anything a regular
//! Pubkey can govern. One can use the multisig as a BPF program upgrade
//! authority, a mint authority, etc.
//!
//! To use, one must first create a `Multisig` account, specifying two important
//! parameters:
//!
//! 1. Owners - the set of addresses that sign transactions for the multisig.
//! 2. Threshold - the number of signers required to execute a transaction.
//!
//! Once the `Multisig` account is created, one can create a `Transaction`
//! account, specifying the parameters for a normal solana transaction.
//!
//! To sign, owners should invoke the `approve` instruction, and finally,
//! the `execute_transaction`, once enough (i.e. `threhsold`) of the owners have
//! signed.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::AccountsClose;
use std::collections::hash_map::DefaultHasher;
use std::convert::Into;
use std::hash::{Hash, Hasher};
use std::ops::{Deref, DerefMut};

declare_id!("FeqQXwTJvmt6YbLTzibZJVvDFq3tKp49zjWkPqDk7oZJ");

#[program]
pub mod multisig {
    use super::*;

    // Initializes a new multisig account with a set of owners and a threshold.
    pub fn create_multisig<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateMultisig<'info>>,
        args: CreateMultisigArgs,
    ) -> Result<()> {
        assert_unique_owners(&args.owners)?;
        require!(
            args.threshold > 0 && args.threshold <= args.owners.len() as u64,
            InvalidThreshold
        );
        require!(!args.owners.is_empty(), InvalidOwnersLen);
        let min_balance = ctx
            .accounts
            .rent
            .minimum_balance(MultisigOwner::space_required() as usize);
        for (index, owner_pubkey) in args.owners.iter().enumerate() {
            let multisig_owner = ctx.remaining_accounts.get(index).unwrap();
            let bump: &u8 = args.bumps.get(index).unwrap();
            let multisig_pubkey = ctx.accounts.multisig.key();
            let multisig_signer = ctx.accounts.owner.as_ref();
            build_multisig_owner(
                multisig_owner,
                multisig_signer,
                multisig_pubkey,
                owner_pubkey,
                bump,
                min_balance,
                ctx.program_id,
            )?
        }

        let multisig = ctx.accounts.multisig.deref_mut();
        *multisig = Multisig {
            name: args.name,
            threshold: args.threshold,
            nonce: args.nonce,
            owner_set_seqno: 0,
            owners_amount: args.owners.len() as u64,
        };
        Ok(())
    }

    // Creates a new transaction account, automatically signed by the creator,
    // which must be one of the owners of the multisig.
    pub fn create_transaction(
        ctx: Context<CreateTransaction>,
        args: CreateTransactionArgs,
    ) -> Result<()> {
        require!(
            ctx.accounts
                .proposer
                .key
                .eq(&ctx.accounts.multisig_owner.owner),
            InvalidOwner
        );

        let owner_hash = hash_pubkey(ctx.accounts.multisig_owner.owner);
        let signers = vec![owner_hash];
        let tx = ctx.accounts.transaction.deref_mut();
        *tx = Transaction {
            multisig: ctx.accounts.multisig.key(),
            program_id: args.pid,
            name: args.name,
            accounts: args.accs,
            data: args.data,
            did_execute: false,
            owner_set_seqno: ctx.accounts.multisig.owner_set_seqno,
            signers,
        };

        Ok(())
    }

    // Approves a transaction on behalf of an owner of the multisig.
    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        require!(
            ctx.accounts
                .multisig_owner
                .multisig
                .eq(&ctx.accounts.transaction.multisig),
            InvalidOwner
        );

        let owner_hash = hash_pubkey(ctx.accounts.multisig_owner.owner);

        require!(
            !ctx.accounts
                .transaction
                .signers
                .iter()
                .any(|signer| owner_hash.eq(signer)),
            AlreadySigned
        );
        ctx.accounts.transaction.signers.push(owner_hash);
        Ok(())
    }

    // Sets the owners field on the multisig. The only way this can be invoked
    // is via a recursive call from execute_transaction -> update_owners_and_threshold.
    pub fn update_owners_and_threshold<'info>(
        ctx: Context<'_, '_, '_, 'info, Auth<'info>>,
        args: UpdateOwnersAndThresholdArgs,
    ) -> Result<()> {
        assert_unique_owners(&args.owners)?;
        let multisig = &mut ctx.accounts.multisig;
        let min_balance = ctx
            .accounts
            .rent
            .minimum_balance(MultisigOwner::space_required() as usize);
        let multisig_signer = ctx.accounts.multisig_signer.as_ref();
        let multisig_pubkey = multisig.key();
        for (index, multisig_owner) in ctx.remaining_accounts.iter().enumerate() {
            match <Account<'info, MultisigOwner>>::try_from(multisig_owner) {
                Ok(multisig_owner) => {
                    multisig_owner.close(multisig_signer.clone()).unwrap();
                    multisig.owners_amount -= 1;
                }
                Err(_) => {
                    let owner_pubkey = args.owners.get(index).unwrap();
                    let bump = args.bumps.get(index).unwrap();
                    build_multisig_owner(
                        multisig_owner,
                        multisig_signer,
                        multisig_pubkey,
                        owner_pubkey,
                        bump,
                        min_balance,
                        ctx.program_id,
                    )?;
                    multisig.owners_amount += 1;
                }
            }
        }
        if !ctx.remaining_accounts.is_empty() {
            multisig.owner_set_seqno += 1;
        }

        // Change threshold
        require!(args.threshold > 0, InvalidThreshold);
        require!(args.threshold <= multisig.owners_amount, InvalidThreshold);
        multisig.threshold = args.threshold;

        Ok(())
    }

    // Executes the given transaction if threshold owners have signed it.
    pub fn execute_transaction(ctx: Context<ExecuteTransaction>) -> Result<()> {
        // Has this been executed already?
        require!(!ctx.accounts.transaction.did_execute, AlreadyExecuted);

        // Do we have enough signers.
        let sig_count = ctx.accounts.transaction.signers.len() as u64;
        require!(
            sig_count >= ctx.accounts.multisig.threshold,
            NotEnoughSigners
        );

        // Execute the transaction signed by the multisig.
        let mut ix: Instruction = (*ctx.accounts.transaction).deref().into();
        ix.accounts = ix
            .accounts
            .iter()
            .map(|acc| {
                let mut acc = acc.clone();
                if &acc.pubkey == ctx.accounts.multisig_signer.key {
                    acc.is_signer = true;
                }
                acc
            })
            .collect();
        let multisig_key = ctx.accounts.multisig.key();
        let seeds = &[multisig_key.as_ref(), &[ctx.accounts.multisig.nonce]];
        let signer = &[&seeds[..]];
        let accounts = ctx.remaining_accounts;

        invoke_signed(&ix, accounts, signer)?;

        // Burn the transaction to ensure one time use.
        ctx.accounts.transaction.did_execute = true;

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateMultisigArgs {
    owners: Vec<Pubkey>,
    threshold: u64,
    nonce: u8,
    name: String,
    bumps: Vec<u8>,
}

#[derive(Accounts)]
#[instruction(args: CreateMultisigArgs)]
pub struct CreateMultisig<'info> {
    #[account(mut)]
    owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = Multisig::space_required(&args.owners, &args.name)
    )]
    multisig: Account<'info, Multisig>,
    system_program: Program<'info, System>,
    rent: Sysvar<'info, Rent>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct CreateTransactionArgs {
    pid: Pubkey,
    accs: Vec<TransactionAccount>,
    data: Vec<u8>,
    name: String,
}

#[derive(Accounts)]
#[instruction(args: CreateTransactionArgs)]
pub struct CreateTransaction<'info> {
    multisig: Account<'info, Multisig>,
    #[account(
        init,
        payer = proposer,
        space = Transaction::space_required(&args.accs, &args.data, &args.name)
    )]
    transaction: Account<'info, Transaction>,

    // One of the owners. Checked in the handler.
    #[account(mut)]
    proposer: Signer<'info>,
    multisig_owner: Account<'info, MultisigOwner>,
    system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    #[account(constraint = multisig.owner_set_seqno == transaction.owner_set_seqno)]
    multisig: Box<Account<'info, Multisig>>,
    #[account(mut, has_one = multisig)]
    transaction: Box<Account<'info, Transaction>>,
    multisig_owner: Account<'info, MultisigOwner>,

    // One of the multisig owners. Checked in the handler.
    owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct Auth<'info> {
    #[account(mut)]
    multisig: Box<Account<'info, Multisig>>,
    #[account(
        mut,
        seeds = [multisig.key().as_ref()],
        bump = multisig.nonce,
    )]
    multisig_signer: Signer<'info>,
    system_program: Program<'info, System>,
    rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteTransaction<'info> {
    #[account(constraint = multisig.owner_set_seqno == transaction.owner_set_seqno)]
    multisig: Box<Account<'info, Multisig>>,

    /// CHECK:
    #[account(
        seeds = [multisig.key().as_ref()],
        bump = multisig.nonce,
    )]
    multisig_signer: UncheckedAccount<'info>,
    #[account(mut, has_one = multisig)]
    transaction: Box<Account<'info, Transaction>>,
}

#[derive(AnchorDeserialize, AnchorSerialize)]
pub struct UpdateOwnersAndThresholdArgs {
    owners: Vec<Pubkey>,
    bumps: Vec<u8>,
    threshold: u64,
}

#[account]
pub struct Multisig {
    pub name: String,
    pub threshold: u64,
    pub nonce: u8,
    pub owner_set_seqno: u32,
    pub owners_amount: u64,
}

impl Multisig {
    pub fn space_required(owners: &[Pubkey], name: &str) -> usize {
        8 + std::mem::size_of::<Self>() + owners.len() * std::mem::size_of::<Pubkey>() + name.len()
    }
}

#[account]
pub struct Transaction {
    /// The multisig account this transaction belongs to.
    pub multisig: Pubkey,
    /// Target program to execute against.
    pub program_id: Pubkey,
    /// Name of transaction.
    pub name: String,
    /// Accounts requried for the transaction.
    pub accounts: Vec<TransactionAccount>,
    /// Instruction data for the transaction.
    pub data: Vec<u8>,
    /// Boolean ensuring one time execution.
    pub did_execute: bool,
    /// Owner set sequence number.
    pub owner_set_seqno: u32,
    /// Signers pubkey hashes
    pub signers: Vec<u64>,
}

impl Transaction {
    pub fn space_required(accounts: &[TransactionAccount], data: &[u8], name: &str) -> usize {
        8 + std::mem::size_of::<Transaction>()
            + accounts.len() * std::mem::size_of::<TransactionAccount>()
            + data.len()
            + name.len()
    }
}

impl From<&Transaction> for Instruction {
    fn from(tx: &Transaction) -> Instruction {
        Instruction {
            program_id: tx.program_id,
            accounts: tx.accounts.iter().map(Into::into).collect(),
            data: tx.data.clone(),
        }
    }
}

#[account]
pub struct MultisigOwner {
    pub multisig: Pubkey,
    pub owner: Pubkey,
}

impl MultisigOwner {
    pub fn space_required() -> usize {
        72
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TransactionAccount {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

impl From<&TransactionAccount> for AccountMeta {
    fn from(account: &TransactionAccount) -> AccountMeta {
        match account.is_writable {
            false => AccountMeta::new_readonly(account.pubkey, account.is_signer),
            true => AccountMeta::new(account.pubkey, account.is_signer),
        }
    }
}

impl From<&AccountMeta> for TransactionAccount {
    fn from(account_meta: &AccountMeta) -> TransactionAccount {
        TransactionAccount {
            pubkey: account_meta.pubkey,
            is_signer: account_meta.is_signer,
            is_writable: account_meta.is_writable,
        }
    }
}

fn assert_unique_owners(owners: &[Pubkey]) -> Result<()> {
    for (i, owner) in owners.iter().enumerate() {
        require!(
            !owners.iter().skip(i + 1).any(|item| item == owner),
            UniqueOwners
        )
    }
    Ok(())
}

fn build_multisig_owner<'info>(
    multisig_owner: &AccountInfo<'info>,
    multisig_signer: &AccountInfo<'info>,
    multisig_pubkey: Pubkey,
    owner_pubkey: &Pubkey,
    bump: &u8,
    min_balance: u64,
    program_id: &Pubkey,
) -> Result<()> {
    invoke_signed(
        &system_instruction::create_account(
            multisig_signer.key,
            multisig_owner.key,
            min_balance,
            MultisigOwner::space_required() as u64,
            program_id,
        ),
        &[multisig_signer.clone(), multisig_owner.clone()],
        &[&[
            "ownership".as_ref(),
            &multisig_pubkey.to_bytes(),
            &owner_pubkey.to_bytes(),
            &[*bump],
        ]],
    )?;

    let multisig_owner_data = MultisigOwner {
        multisig: multisig_pubkey,
        owner: *owner_pubkey,
    };
    multisig_owner_data.try_serialize(&mut &mut multisig_owner.data.borrow_mut()[..])?;
    Ok(())
}

pub fn hash_pubkey(pubkey: Pubkey) -> u64 {
    let mut hasher = DefaultHasher::new();
    pubkey.to_bytes().hash(&mut hasher);
    hasher.finish()
}

#[error]
pub enum ErrorCode {
    #[msg("The given owner is not part of this multisig.")]
    InvalidOwner,
    #[msg("Owners length must be non zero.")]
    InvalidOwnersLen,
    #[msg("Not enough owners signed this transaction.")]
    NotEnoughSigners,
    #[msg("Cannot delete a transaction that has been signed by an owner.")]
    TransactionAlreadySigned,
    #[msg("Overflow when adding.")]
    Overflow,
    #[msg("Cannot delete a transaction the owner did not create.")]
    UnableToDelete,
    #[msg("The given transaction has already been executed.")]
    AlreadyExecuted,
    #[msg("Threshold must be less than or equal to the number of owners.")]
    InvalidThreshold,
    #[msg("Owners must be unique")]
    UniqueOwners,
    #[msg("The owner has already signed the transaction")]
    AlreadySigned,
}
