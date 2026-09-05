// Generated from the Supabase project "Auto-assign Config" (ref qudnkxivfgntwvmydpkt)
// via `generate_typescript_types` on 2026-07-04. Regenerate after any schema change.
// Not yet consumed by the app — see docs/supabase-migration.md (phase 3).
//
// THIS FILE COVERS ONE OF THE TWO PROJECTS, and not the one the dashboard talks to.
// `tat_legs`, `pay_jobs` and `pay_punches` are absent below because they live in
// the OTHER project (odbmfkzkipklepmghjwj) — the one NEXT_PUBLIC_SUPABASE_URL
// points at. Regenerating against the ref in the line above will therefore keep
// producing a file with no TAT and no pay in it; that is correct, not a stale
// export. See the two-project note in dashboard/.env.example, which also records
// that the two sit under different Supabase logins.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      drivers: {
        Row: {
          bot_token: string | null
          code_name: string | null
          driver_id: string
          driver_name: string
          email: string | null
          employee_code: string | null
          employee_full_name: string | null
          end_location_customer_id: string | null
          is_active: boolean | null
          phone_code: string | null
          phone_number: string | null
          phone_number_update: string | null
          sheet_row: number
          shift_time_end: string | null
          shift_time_start: string | null
          start_location_customer_id: string | null
          zalo_chat_id: string | null
        }
        Insert: {
          bot_token?: string | null
          code_name?: string | null
          driver_id: string
          driver_name: string
          email?: string | null
          employee_code?: string | null
          employee_full_name?: string | null
          end_location_customer_id?: string | null
          is_active?: boolean | null
          phone_code?: string | null
          phone_number?: string | null
          phone_number_update?: string | null
          sheet_row: number
          shift_time_end?: string | null
          shift_time_start?: string | null
          start_location_customer_id?: string | null
          zalo_chat_id?: string | null
        }
        Update: {
          bot_token?: string | null
          code_name?: string | null
          driver_id?: string
          driver_name?: string
          email?: string | null
          employee_code?: string | null
          employee_full_name?: string | null
          end_location_customer_id?: string | null
          is_active?: boolean | null
          phone_code?: string | null
          phone_number?: string | null
          phone_number_update?: string | null
          sheet_row?: number
          shift_time_end?: string | null
          shift_time_start?: string | null
          start_location_customer_id?: string | null
          zalo_chat_id?: string | null
        }
        Relationships: []
      }
      leave_status: {
        Row: {
          day: number | null
          driver_id: string | null
          driver_name: string | null
          id: number
          leave_from: string | null
          leave_from_hr: string | null
          leave_to: string | null
          leave_to_hr: string | null
          loai_nghi: string | null
          note: string | null
          sheet_row: number
          submitted_at: string | null
          vi_tri: string | null
        }
        Insert: {
          day?: number | null
          driver_id?: string | null
          driver_name?: string | null
          id?: never
          leave_from?: string | null
          leave_from_hr?: string | null
          leave_to?: string | null
          leave_to_hr?: string | null
          loai_nghi?: string | null
          note?: string | null
          sheet_row: number
          submitted_at?: string | null
          vi_tri?: string | null
        }
        Update: {
          day?: number | null
          driver_id?: string | null
          driver_name?: string | null
          id?: never
          leave_from?: string | null
          leave_from_hr?: string | null
          leave_to?: string | null
          leave_to_hr?: string | null
          loai_nghi?: string | null
          note?: string | null
          sheet_row?: number
          submitted_at?: string | null
          vi_tri?: string | null
        }
        Relationships: []
      }
      leave_subs: {
        Row: {
          cover_from: string | null
          cover_to: string | null
          leave_id: number
          slot: number
          sub_id: string | null
          sub_name: string | null
        }
        Insert: {
          cover_from?: string | null
          cover_to?: string | null
          leave_id: number
          slot: number
          sub_id?: string | null
          sub_name?: string | null
        }
        Update: {
          cover_from?: string | null
          cover_to?: string | null
          leave_id?: number
          slot?: number
          sub_id?: string | null
          sub_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leave_subs_leave_id_fkey"
            columns: ["leave_id"]
            isOneToOne: false
            referencedRelation: "leave_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_subs_leave_id_fkey"
            columns: ["leave_id"]
            isOneToOne: false
            referencedRelation: "v_leave_status"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          address_line_1: string | null
          customer_id: string
          customer_name: string
          dropoff_id: string | null
          dropoff_name: string | null
          eta: string | null
          export_status: string | null
          lat: number | null
          lng: number | null
          nearest_dropoff: string | null
          new_ward: string | null
          sheet_row: number
        }
        Insert: {
          address_line_1?: string | null
          customer_id: string
          customer_name: string
          dropoff_id?: string | null
          dropoff_name?: string | null
          eta?: string | null
          export_status?: string | null
          lat?: number | null
          lng?: number | null
          nearest_dropoff?: string | null
          new_ward?: string | null
          sheet_row: number
        }
        Update: {
          address_line_1?: string | null
          customer_id?: string
          customer_name?: string
          dropoff_id?: string | null
          dropoff_name?: string | null
          eta?: string | null
          export_status?: string | null
          lat?: number | null
          lng?: number | null
          nearest_dropoff?: string | null
          new_ward?: string | null
          sheet_row?: number
        }
        Relationships: []
      }
      mappings: {
        Row: {
          alt_drop_off_id: string | null
          alt_drop_off_name: string | null
          area_public_on_schedule: string | null
          customer_id: string | null
          day_type: string
          driver_id: string | null
          driver_is_manual_override: boolean | null
          driver_name: string | null
          id: number
          pickup_name: string | null
          sheet_row: number
          shift_end: string | null
          shift_start: string | null
          smart_driver_ids: string[]
        }
        Insert: {
          alt_drop_off_id?: string | null
          alt_drop_off_name?: string | null
          area_public_on_schedule?: string | null
          customer_id?: string | null
          day_type: string
          driver_id?: string | null
          driver_is_manual_override?: boolean | null
          driver_name?: string | null
          id?: never
          pickup_name?: string | null
          sheet_row: number
          shift_end?: string | null
          shift_start?: string | null
          smart_driver_ids?: string[]
        }
        Update: {
          alt_drop_off_id?: string | null
          alt_drop_off_name?: string | null
          area_public_on_schedule?: string | null
          customer_id?: string | null
          day_type?: string
          driver_id?: string | null
          driver_is_manual_override?: boolean | null
          driver_name?: string | null
          id?: never
          pickup_name?: string | null
          sheet_row?: number
          shift_end?: string | null
          shift_start?: string | null
          smart_driver_ids?: string[]
        }
        Relationships: []
      }
      schedule_jobs: {
        Row: {
          delivery_window: string | null
          driver_id: string | null
          driver_name: string | null
          dropoff_id: string | null
          dropoff_name: string | null
          friday: boolean
          id: number
          monday: boolean
          pickup_id: string | null
          pickup_name: string | null
          reference: string | null
          saturday: boolean
          sent_to_driver_before: number | null
          sheet_row: number
          sunday: boolean
          thursday: boolean
          tuesday: boolean
          wednesday: boolean
        }
        Insert: {
          delivery_window?: string | null
          driver_id?: string | null
          driver_name?: string | null
          dropoff_id?: string | null
          dropoff_name?: string | null
          friday?: boolean
          id?: never
          monday?: boolean
          pickup_id?: string | null
          pickup_name?: string | null
          reference?: string | null
          saturday?: boolean
          sent_to_driver_before?: number | null
          sheet_row: number
          sunday?: boolean
          thursday?: boolean
          tuesday?: boolean
          wednesday?: boolean
        }
        Update: {
          delivery_window?: string | null
          driver_id?: string | null
          driver_name?: string | null
          dropoff_id?: string | null
          dropoff_name?: string | null
          friday?: boolean
          id?: never
          monday?: boolean
          pickup_id?: string | null
          pickup_name?: string | null
          reference?: string | null
          saturday?: boolean
          sent_to_driver_before?: number | null
          sheet_row?: number
          sunday?: boolean
          thursday?: boolean
          tuesday?: boolean
          wednesday?: boolean
        }
        Relationships: []
      }
      scheduled_trips_by_driver: {
        Row: {
          full_name: string
          sheet_row: number
          weekday_trips: string | null
          weekend_trips: string | null
        }
        Insert: {
          full_name: string
          sheet_row: number
          weekday_trips?: string | null
          weekend_trips?: string | null
        }
        Update: {
          full_name?: string
          sheet_row?: number
          weekday_trips?: string | null
          weekend_trips?: string | null
        }
        Relationships: []
      }
      sunday_schedule: {
        Row: {
          area: string | null
          ca: string | null
          full_name: string | null
          id: number
          note: string | null
          sheet_row: number
          stt: string | null
          work_date: string | null
        }
        Insert: {
          area?: string | null
          ca?: string | null
          full_name?: string | null
          id?: never
          note?: string | null
          sheet_row: number
          stt?: string | null
          work_date?: string | null
        }
        Update: {
          area?: string | null
          ca?: string | null
          full_name?: string | null
          id?: never
          note?: string | null
          sheet_row?: number
          stt?: string | null
          work_date?: string | null
        }
        Relationships: []
      }
      tpl_entries: {
        Row: {
          address: string | null
          id: number
          psc_tinh: string
          sheet_row: number
          tpl_name: string | null
          tpl_uuid: string | null
        }
        Insert: {
          address?: string | null
          id?: never
          psc_tinh: string
          sheet_row: number
          tpl_name?: string | null
          tpl_uuid?: string | null
        }
        Update: {
          address?: string | null
          id?: never
          psc_tinh?: string
          sheet_row?: number
          tpl_name?: string | null
          tpl_uuid?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      v_config: {
        Row: {
          alt_drop_off_id: string | null
          area_public_on_schedule: string | null
          bot_token: string | null
          chat_id: string | null
          customer_id: string | null
          day_type: string | null
          driver_id: string | null
          first_name_last_name: string | null
          pickup_name: string | null
          sheet_row: number | null
          shift_end: string | null
          shift_start: string | null
          smart_driver_ids: string[] | null
        }
        Relationships: []
      }
      v_leave_status: {
        Row: {
          day: number | null
          driver_id: string | null
          driver_name: string | null
          id: number | null
          leave_from: string | null
          leave_from_hr: string | null
          leave_to: string | null
          leave_to_hr: string | null
          loai_nghi: string | null
          note: string | null
          scheduled_trips: string | null
          sheet_row: number | null
          submitted_at: string | null
          subs: Json | null
          vi_tri: string | null
        }
        Relationships: []
      }
      v_mappings_recomputed: {
        Row: {
          alt_drop_off_id: string | null
          alt_drop_off_id_recomputed: string | null
          customer_id: string | null
          customer_id_recomputed: string | null
          day_type: string | null
          driver_id: string | null
          driver_id_recomputed: string | null
          driver_name: string | null
          id: number | null
          pickup_name: string | null
          sheet_row: number | null
        }
        Relationships: []
      }
      v_sunday_driver_by_area: {
        Row: {
          area_public_on_schedule: string | null
          customer_id: string | null
          driver_id: string | null
          driver_name: string | null
          mapping_id: number | null
          scheduled_code_name: string | null
          work_date: string | null
        }
        Relationships: []
      }
      v_sunday_schedule: {
        Row: {
          area: string | null
          ca: string | null
          full_name: string | null
          id: number | null
          note: string | null
          phone: string | null
          sheet_row: number | null
          stt: string | null
          work_date: string | null
          xin_nghi: string | null
        }
        Relationships: []
      }
      v_tpl_entries: {
        Row: {
          address: string | null
          address_recomputed: string | null
          id: number | null
          psc_tinh: string | null
          sheet_row: number | null
          tpl_name: string | null
          tpl_uuid: string | null
          tpl_uuid_recomputed: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      truncate_sheet_mirror: { Args: never; Returns: undefined }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
