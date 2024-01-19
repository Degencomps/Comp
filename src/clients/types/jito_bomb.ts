export type JitoBomb = {
  "version": "0.1.0",
  "name": "jito_bomb",
  "instructions": [
    {
      "name": "startLedger",
      "accounts": [
        {
          "name": "signer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "monitorAta",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "ledgerAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        }
      ]
    },
    {
      "name": "endLedger",
      "accounts": [
        {
          "name": "signer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "monitorAta",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "ledgerAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tipAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        },
        {
          "name": "minProfit",
          "type": "u64"
        },
        {
          "name": "lamportsPerMonitorToken",
          "type": "f64"
        },
        {
          "name": "profitMarginBps",
          "type": "u64"
        },
        {
          "name": "maxTipBps",
          "type": "u64"
        },
        {
          "name": "minimumTipAmt",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "ledgerAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenBalance",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "events": [
    {
      "name": "Event",
      "fields": [
        {
          "name": "profit",
          "type": "u64",
          "index": false
        },
        {
          "name": "tip",
          "type": "u64",
          "index": false
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "AddressMismatch",
      "msg": "Address Mismatch"
    },
    {
      "code": 6001,
      "name": "ProgramMismatch",
      "msg": "Program Mismatch"
    },
    {
      "code": 6002,
      "name": "MissingEndLedger",
      "msg": "Missing End Ledger"
    },
    {
      "code": 6003,
      "name": "IncorrectMonitorATA",
      "msg": "Incorrect Monitor ATA"
    },
    {
      "code": 6004,
      "name": "CannotStartLedgerBeforeEnd",
      "msg": "Cannot Start Ledger Before End"
    },
    {
      "code": 6005,
      "name": "MinimumProfitNotMet",
      "msg": "Minimum Profit Not Met"
    },
    {
      "code": 6006,
      "name": "ProfitLessThanMinimumTip",
      "msg": "Profit Less Than Minimum Tip"
    },
    {
      "code": 6007,
      "name": "UnknownInstruction",
      "msg": "Unknown Instruction"
    }
  ]
};

export const IDL: JitoBomb = {
  "version": "0.1.0",
  "name": "jito_bomb",
  "instructions": [
    {
      "name": "startLedger",
      "accounts": [
        {
          "name": "signer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "monitorAta",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "ledgerAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        }
      ]
    },
    {
      "name": "endLedger",
      "accounts": [
        {
          "name": "signer",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "monitorAta",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "ledgerAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tipAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "instructions",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "seed",
          "type": "u64"
        },
        {
          "name": "minProfit",
          "type": "u64"
        },
        {
          "name": "lamportsPerMonitorToken",
          "type": "f64"
        },
        {
          "name": "profitMarginBps",
          "type": "u64"
        },
        {
          "name": "maxTipBps",
          "type": "u64"
        },
        {
          "name": "minimumTipAmt",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "ledgerAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenBalance",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "events": [
    {
      "name": "Event",
      "fields": [
        {
          "name": "profit",
          "type": "u64",
          "index": false
        },
        {
          "name": "tip",
          "type": "u64",
          "index": false
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "AddressMismatch",
      "msg": "Address Mismatch"
    },
    {
      "code": 6001,
      "name": "ProgramMismatch",
      "msg": "Program Mismatch"
    },
    {
      "code": 6002,
      "name": "MissingEndLedger",
      "msg": "Missing End Ledger"
    },
    {
      "code": 6003,
      "name": "IncorrectMonitorATA",
      "msg": "Incorrect Monitor ATA"
    },
    {
      "code": 6004,
      "name": "CannotStartLedgerBeforeEnd",
      "msg": "Cannot Start Ledger Before End"
    },
    {
      "code": 6005,
      "name": "MinimumProfitNotMet",
      "msg": "Minimum Profit Not Met"
    },
    {
      "code": 6006,
      "name": "ProfitLessThanMinimumTip",
      "msg": "Profit Less Than Minimum Tip"
    },
    {
      "code": 6007,
      "name": "UnknownInstruction",
      "msg": "Unknown Instruction"
    }
  ]
};
